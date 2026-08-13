import {
  makeFunctionProvider,
  resolveFunctionBundleConfig,
  type Function as LambdaFunction,
  type FunctionCodeBundle,
  type FunctionProps,
} from "@/AWS/Lambda/Function";
import * as Bundle from "@/Bundle/Bundle";
import { isResolved, stripEffects } from "@/Diff";
import * as Provider from "@/Provider";
import { Resource } from "@/Resource";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

interface HermeticFunction extends Resource<
  "Test.HermeticFunction",
  FunctionProps,
  LambdaFunction["Attributes"]
> {}

const HermeticFunction = Resource<HermeticFunction>("Test.HermeticFunction");

const bundleCode = Effect.fn(function* (
  _id: string,
  props: FunctionProps,
): Effect.fn.Return<FunctionCodeBundle, Bundle.BundleError> {
  const config = yield* resolveFunctionBundleConfig(props).pipe(
    Effect.mapError((cause) =>
      cause instanceof Bundle.BundleError
        ? cause
        : new Bundle.BundleError({
            message: "Failed to resolve the hermetic Lambda bundle",
            cause,
          }),
    ),
  );
  const bundle = yield* Bundle.build(
    config.inputOptions,
    config.outputOptions,
    config.extra,
  );
  return {
    identityHash: bundle.hash,
    buildArchive: Effect.succeed({
      archive: new Uint8Array(),
      archiveHash: bundle.hash,
    }),
  };
});

const HermeticFunctionProvider = () =>
  Provider.effect(
    HermeticFunction,
    Effect.gen(function* () {
      const lambda = yield* makeFunctionProvider({ bundleCode });
      return {
        stables: lambda.stables,
        list: () => Effect.succeed([]),
        diff: (input: any) => lambda.diff!(input),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const desired = stripEffects(news);
          if (!isResolved(desired)) {
            return yield* Effect.die(
              new Error("Hermetic Function received unresolved props"),
            );
          }
          const bundle = yield* bundleCode(id, desired);
          yield* bundle.buildArchive;
          return {
            functionArn:
              output?.functionArn ??
              `arn:aws:lambda:us-east-1:123:function:${id}`,
            functionName: output?.functionName ?? id,
            functionUrl: undefined,
            roleName: output?.roleName ?? `${id}-role`,
            roleArn: output?.roleArn ?? `arn:aws:iam::123:role/${id}-role`,
            code: { hash: bundle.identityHash },
          };
        }),
        delete: () => Effect.void,
      };
    }),
  );

const { test } = Test.make({
  providers: HermeticFunctionProvider(),
  state: inMemoryState(),
});

test.provider(
  "applies a transitive source edit and returns to noop",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-source-apply-",
      });
      const entry = path.join(root, "handler.mjs");
      const dependency = path.join(root, "dependency.mjs");

      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      yield* fs.writeFileString(
        entry,
        'import { generation } from "./dependency.mjs"; export const handler = () => generation;',
      );
      const writeDependency = (generation: string) =>
        fs.writeFileString(
          dependency,
          `export const generation = ${JSON.stringify(generation)};`,
        );
      const program = () =>
        HermeticFunction("Function", {
          main: entry,
          isExternal: true,
          // Mirrors the runtime-only Effect that Platform() attaches to an
          // Effectful Lambda declaration. State intentionally omits it.
          exports: Effect.succeed(["handler"]),
        });

      yield* writeDependency("generation-one");
      yield* stack.deploy(program());

      const unchanged = yield* stack.plan(program());
      expect(unchanged.resources.Function).toMatchObject({ action: "noop" });

      yield* writeDependency("generation-two");
      const changed = yield* stack.plan(program());
      expect(changed.resources.Function).toMatchObject({ action: "update" });

      const applied = yield* stack.deploy(program());
      expect(applied.code.hash).not.toBe(
        unchanged.resources.Function.state?.attr?.code.hash,
      );

      const converged = yield* stack.plan(program());
      expect(converged.resources.Function).toMatchObject({ action: "noop" });
    }),
  { timeout: 30_000 },
);
