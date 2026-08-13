import * as AWS from "@/AWS";
import {
  resolveFunctionBundleConfig,
  type FunctionProps,
} from "@/AWS/Lambda/Function.ts";
import * as Bundle from "@/Bundle/Bundle.ts";
import { isResolved, stripEffects } from "@/Diff.ts";
import * as Provider from "@/Provider.ts";
import { inMemoryState } from "@/State/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { Credentials } from "@distilled.cloud/aws";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { pathToFileURL } from "node:url";
import NestedDurableParentLive, {
  NestedDurableParent,
} from "./fixtures/nested-durable-parent.ts";

const reconciled = new Map<string, FunctionProps>();

const functionProvider = () =>
  Provider.succeed(AWS.Lambda.Function, {
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desired = stripEffects(news);
      if (!isResolved(desired)) {
        return yield* Effect.die(
          new Error(`Function ${id} received unresolved props`),
        );
      }
      reconciled.set(id, desired);
      return {
        functionArn:
          output?.functionArn ??
          `arn:aws:lambda:us-east-1:123:function:${id}-deployed`,
        functionName: output?.functionName ?? `${id}-deployed`,
        functionUrl: undefined,
        roleName: output?.roleName ?? `${id}-role`,
        roleArn: output?.roleArn ?? `arn:aws:iam::123:role/${id}-role`,
        code: { hash: "hermetic-code" },
      };
    }),
    delete: () => Effect.void,
  });

const { test } = Test.make({
  providers: Layer.mergeAll(functionProvider(), Credentials.mock),
  state: inMemoryState(),
});

const program = () =>
  NestedDurableParent.pipe(Effect.provide(NestedDurableParentLive));

test.provider(
  "serializes a nested DurableFunction identity through plan, apply, and runtime",
  (stack) =>
    Effect.gen(function* () {
      reconciled.clear();

      const plan = yield* stack.plan(program());
      expect(plan.resources.NestedDurable.downstream).toContain(
        "NestedDurableParent",
      );

      yield* stack.deploy(program());
      const parent = reconciled.get("NestedDurableParent");
      expect(parent).toBeDefined();
      const boundNames = Object.values(parent?.env ?? {});
      expect(boundNames).toContain("NestedDurable-deployed");

      const config = yield* resolveFunctionBundleConfig(parent!, {
        registerRuntimeExtension: false,
        externalizeAwsSdk: false,
      });
      const bundle = yield* Bundle.build(
        config.inputOptions,
        config.outputOptions,
        config.extra,
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bundleDir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-nested-durable-runtime-",
      });
      yield* Effect.forEach(bundle.files, (file) =>
        fs.writeFile(
          path.join(bundleDir, file.path),
          typeof file.content === "string"
            ? new TextEncoder().encode(file.content)
            : file.content,
        ),
      );

      const requests: string[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              requests.push(request.url);
              const invoke = new URL(request.url).pathname.endsWith(
                "/invocations",
              );
              return new Response(invoke ? "{}" : '{"DurableExecutions":[]}', {
                status: invoke ? 202 : 200,
                headers: { "content-type": "application/json" },
              });
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      );

      const runtimeEnv = {
        ...(parent?.env ?? {}),
        ALCHEMY_AWS_ACCOUNT_ID: "123",
        ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify({
          lambda: server.url.origin,
        }),
        ALCHEMY_STACK_NAME: "nested-durable-test",
        ALCHEMY_STAGE: "test",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_REGION: "us-east-1",
      } satisfies Record<string, string>;
      const previousEnv = Object.fromEntries(
        Object.keys(runtimeEnv).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, runtimeEnv);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
      );

      const entry = path.join(bundleDir, bundle.files[0].path);
      const module = (yield* Effect.promise(
        () => import(`${pathToFileURL(entry).href}?test=${Date.now()}`),
      )) as {
        default: (
          event: { operation: "start" | "list" },
          context: object,
        ) => Promise<unknown>;
      };

      expect(
        yield* Effect.promise(() => module.default({ operation: "start" }, {})),
      ).toMatchObject({ statusCode: 202 });
      expect(
        yield* Effect.promise(() => module.default({ operation: "list" }, {})),
      ).toMatchObject({ DurableExecutions: [] });
      expect(requests).toHaveLength(2);
      expect(
        requests.every((request) => request.includes("NestedDurable-deployed")),
      ).toBe(true);

      const functionNameKey = Object.entries(parent?.env ?? {}).find(
        ([, value]) => value === "NestedDurable-deployed",
      )?.[0];
      expect(functionNameKey).toBeDefined();
      delete process.env[functionNameKey!];
      const unresolved = yield* Effect.exit(
        Effect.tryPromise({
          try: () => module.default({ operation: "list" }, {}),
          catch: (cause) => cause,
        }),
      );
      expect(Exit.isFailure(unresolved)).toBe(true);
      if (Exit.isFailure(unresolved)) {
        expect(Cause.pretty(unresolved.cause)).toContain(
          "Expected string, got undefined",
        );
      }
      expect(requests).toHaveLength(2);
    }),
  { timeout: 60_000 },
);
