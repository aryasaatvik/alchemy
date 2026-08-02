/**
 * First-class live/local provider selection for Lambda Functions.
 *
 * Local mode provisions the ordinary Lambda resource against the configured
 * LocalStack-compatible emulator. The live bridge remains available as an
 * explicit provider for the separate Live Lambda development mode.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import * as LocalProvider from "../../Local/LocalProvider.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as Provider from "../../Provider.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { AWSEnvironment } from "../Environment.ts";
import { AWS_LOCAL_ENTRY_URL, localRuntimeServices } from "../LocalRuntime.ts";
import {
  Function,
  makeFunctionProvider,
  materializeLambdaEnvironment,
  mergeFunctionEnvironment,
  resolveFunctionBundleConfig,
  resolveFunctionEnvironment,
  resolveFunctionRuntimeEnv,
  toTimeoutSeconds,
  type FunctionProps,
  validateLambdaEnvironment,
} from "./Function.ts";
import { bridgeCodeBundle } from "./Live/BridgeBundle.ts";
import { LiveLambdaRuntime } from "./Live/LiveRuntime.ts";

export const FunctionProvider = () =>
  ProviderLayer.dual(Function, {
    live: () => LiveFunctionProvider(),
    local: () => LocalEmulatorFunctionProvider(),
    modeTransition: "in-place",
  });

export const LiveFunctionProvider = () =>
  Provider.effect(Function, makeFunctionProvider());

/**
 * The normal Lambda lifecycle pointed at an account-scoped local AWS endpoint.
 * `AWSEnvironment` provides the endpoint and credentials; keeping this as the
 * ordinary provider exercises the same bundle/create/update path as deploys.
 */
export const LocalEmulatorFunctionProvider = () =>
  Provider.effect(Function, makeFunctionProvider());

const usableSession = (
  session: ScopedPlanStatusSession | undefined,
): ScopedPlanStatusSession =>
  typeof session?.note === "function"
    ? session
    : {
        note: (note: string) => Effect.logDebug(note),
        emit: () => Effect.void,
        done: () => Effect.void,
      };

const devTimeout = (
  timeout: Duration.Duration | undefined,
): Duration.Duration =>
  Duration.seconds(Math.max(toTimeoutSeconds(timeout) ?? 3, 60));

const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "-");

type FunctionBinding = ResourceBinding<Function["Binding"]>;

type LocalFunctionProviderRequirements =
  | AlchemyContext
  | AWSEnvironment
  | FileSystem.FileSystem
  | LiveLambdaRuntime
  | Path.Path
  | Stack;

export const LocalFunctionProvider = () =>
  LocalProvider.make<
    Function,
    LocalProvider.DefaultLocalConfig<Function>,
    never,
    LocalFunctionProviderRequirements,
    AWSEnvironment | Stack
  >(
    Function,
    AWS_LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const live = yield* makeFunctionProvider({
        bundleCode: () => bridgeCodeBundle,
      });
      const alchemyEnv = yield* resolveFunctionRuntimeEnv;
      const runtime = yield* LiveLambdaRuntime;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dotAlchemy } = yield* AlchemyContext;

      const liveBinding = (id: string): FunctionBinding => ({
        sid: "alchemy:live-lambda",
        data: {
          env: {
            ALCHEMY_LIVE_APPSYNC_HTTP: runtime.eventApi.httpEndpoint,
            ALCHEMY_LIVE_APPSYNC_REALTIME: runtime.eventApi.realtimeEndpoint,
            ALCHEMY_LIVE_FUNCTION_ID: id,
          },
          policyStatements: [
            {
              Sid: "AlchemyLiveLambda",
              Effect: "Allow",
              Action: [
                "appsync:EventConnect",
                "appsync:EventPublish",
                "appsync:EventSubscribe",
              ],
              Resource: [
                runtime.eventApi.apiArn,
                `${runtime.eventApi.apiArn}/*`,
              ],
            } satisfies PolicyStatement,
          ],
        },
      });

      const toDevProps = (props: FunctionProps): FunctionProps => ({
        ...props,
        handler: "handler",
        isExternal: true,
        timeout: devTimeout(props.timeout),
        // The bridge never executes app code. The resolved application env is
        // injected into the local handler child via `setTarget` after the
        // local provider validates it against Lambda's 4 KiB limit.
        env: undefined,
      });

      // Strip only `data.env` from the deployed copy; `policyStatements`
      // stay because the bridge forwards its execution-role credentials to
      // the local child, which therefore needs the bindings' permissions.
      const stripBindingEnv = (
        bindings: FunctionBinding[],
      ): FunctionBinding[] =>
        bindings.map((binding) =>
          binding?.data?.env
            ? { ...binding, data: { ...binding.data, env: undefined } }
            : binding,
        );

      const toDevBindings = (id: string, bindings: FunctionBinding[]) => [
        ...stripBindingEnv(bindings),
        liveBinding(id),
      ];

      const activeBindingEnv = (bindings: FunctionBinding[]) =>
        bindings
          .filter(
            (binding: FunctionBinding & { action?: string }) =>
              binding?.action !== "delete",
          )
          .map((binding) => binding?.data?.env)
          .reduce<Record<string, string>>(
            (acc, env) => ({ ...acc, ...(env as Record<string, string>) }),
            {},
          );

      const localTargetEnv = (
        props: FunctionProps,
        bindings: FunctionBinding[],
      ): Record<string, string> =>
        materializeLambdaEnvironment(applicationEnvironment(props, bindings));

      function applicationEnvironment(
        props: FunctionProps,
        bindings: FunctionBinding[],
      ) {
        return resolveFunctionEnvironment(
          mergeFunctionEnvironment(activeBindingEnv(bindings), props),
          props,
          alchemyEnv,
        );
      }

      const runWatch = Effect.fn(function* (
        id: string,
        props: FunctionProps,
        env: Record<string, string>,
        ready: Deferred.Deferred<void>,
      ) {
        const config = yield* resolveFunctionBundleConfig(props, {
          externalizeAwsSdk: false,
          registerRuntimeExtension: false,
        });
        const bundleDir = path.join(
          dotAlchemy,
          "local",
          "aws",
          "lambda",
          sanitizeId(id),
        );
        yield* fs.makeDirectory(bundleDir, { recursive: true });
        const handler = props.isExternal
          ? (props.handler ?? "default")
          : "default";
        let startedAt = Date.now();
        let firstBuild = true;

        yield* Bundle.watch(config.inputOptions, {
          ...config.outputOptions,
          dir: bundleDir,
        }).pipe(
          Stream.tap((event) => {
            if (event._tag === "Start") {
              startedAt = Date.now();
            } else if (event._tag === "Error") {
              return Effect.logError(`[${id}] Build error`, event.error);
            }
            return Effect.void;
          }),
          Stream.filterMap((event) =>
            event._tag === "Success"
              ? Result.succeed(event.output)
              : Result.failVoid,
          ),
          Stream.mapEffect((bundle) =>
            Effect.gen(function* () {
              for (const file of bundle.files) {
                const filePath = path.join(bundleDir, file.path);
                yield* fs.makeDirectory(path.dirname(filePath), {
                  recursive: true,
                });
                if (typeof file.content === "string") {
                  yield* fs.writeFileString(filePath, file.content);
                } else {
                  yield* fs.writeFile(filePath, file.content);
                }
              }
              yield* runtime.setTarget(id, {
                bundlePath: path.join(bundleDir, "index.js"),
                handler,
                env,
              });
              yield* Effect.log(
                `[${id}] ${firstBuild ? "Serving locally" : "Rebuilt"} in ${Date.now() - startedAt}ms`,
              );
              firstBuild = false;
              yield* Deferred.succeed(ready, undefined);
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`[${id}] Failed to serve locally`, cause),
              ),
            ),
          ),
          Stream.runDrain,
        );
      });

      return {
        precreate: Effect.fn(function* (args) {
          return yield* live.precreate!({
            ...args,
            news: toDevProps(args.news),
            bindings: toDevBindings(args.id, args.bindings),
            session: usableSession(args.session),
          });
        }),
        tail: live.tail,
        logs: live.logs,
        start: Effect.fn(function* (ctx) {
          // Live Lambda deploys a small bridge, but its local child receives
          // the complete application env. Validate that complete env here,
          // before `toDevProps` strips it from the bridge Lambda.
          yield* validateLambdaEnvironment(
            applicationEnvironment(ctx.news, ctx.bindings),
          );
          if (ctx.news.durableConfig) {
            return yield* Effect.fail(
              new Error("Live Lambda does not support durable functions"),
            );
          }
          if (
            typeof ctx.news.url === "object" &&
            ctx.news.url.invokeMode === "RESPONSE_STREAM"
          ) {
            return yield* Effect.fail(
              new Error("Live Lambda does not support RESPONSE_STREAM"),
            );
          }

          const ready = yield* Deferred.make<void>();
          yield* runWatch(
            ctx.id,
            ctx.news,
            localTargetEnv(ctx.news, ctx.bindings),
            ready,
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: "120 seconds",
              orElse: () =>
                Effect.fail(
                  new Error(`[${ctx.id}] initial local build timed out`),
                ),
            }),
          );

          return yield* live.reconcile({
            id: ctx.id,
            fqn: ctx.fqn,
            instanceId: ctx.instanceId,
            news: toDevProps(ctx.news),
            olds: ctx.olds ? toDevProps(ctx.olds) : undefined,
            output: ctx.output,
            bindings: toDevBindings(ctx.id, ctx.bindings),
            session: usableSession(ctx.session),
          });
        }),
        deactivate: (ctx) => runtime.removeTarget(ctx.id),
        stop: Effect.fn(function* (ctx) {
          yield* live.delete({
            ...ctx,
            olds: toDevProps(ctx.olds),
            bindings: toDevBindings(ctx.id, ctx.bindings),
            session: usableSession(ctx.session),
          });
        }),
      } as LocalProvider.LocalProviderSpec<Function>;
    }),
    { sidecarEnvironment: resolveFunctionRuntimeEnv },
  );
