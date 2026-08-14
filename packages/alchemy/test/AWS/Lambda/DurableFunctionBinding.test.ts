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
  NestedDurable,
  NestedDurableParent,
} from "./fixtures/nested-durable-parent.ts";
import SelfDurableLive, { SelfDurable } from "./fixtures/self-durable.ts";

const reconciled = new Map<string, FunctionProps>();

const functionAttributes = (id: string) => ({
  functionArn: `arn:aws:lambda:us-east-1:123:function:${id}-deployed`,
  functionName: `${id}-deployed`,
  functionUrl: undefined,
  roleName: `${id}-role`,
  roleArn: `arn:aws:iam::123:role/${id}-role`,
  code: { hash: "hermetic-code" },
});

const functionProvider = () =>
  Provider.succeed(AWS.Lambda.Function, {
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
    }),
    precreate: Effect.fn(function* ({ id }) {
      return functionAttributes(id);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desired = stripEffects(news);
      if (!isResolved(desired)) {
        return yield* Effect.die(
          new Error(`Function ${id} received unresolved props`),
        );
      }
      reconciled.set(id, desired);
      return output ?? functionAttributes(id);
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
        ...parent?.env,
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
          event: { operation: "start" | "list" | "implicit-list" },
          context: object,
        ) => Promise<unknown>;
      };

      expect(
        yield* Effect.promise(() => module.default({ operation: "start" }, {})),
      ).toMatchObject({ statusCode: 202 });
      expect(
        yield* Effect.promise(() => module.default({ operation: "list" }, {})),
      ).toMatchObject({ DurableExecutions: [] });
      expect(
        yield* Effect.promise(() =>
          module.default({ operation: "implicit-list" }, {}),
        ),
      ).toMatchObject({ DurableExecutions: [] });
      expect(requests).toHaveLength(3);
      const [startRequest, explicitListRequest, implicitListRequest] =
        requests.map((request) => new URL(request));
      expect(startRequest.pathname).toContain(
        "/functions/NestedDurable-deployed/invocations",
      );
      expect(startRequest.searchParams.get("Qualifier")).toBe("live");
      for (const request of [explicitListRequest, implicitListRequest]) {
        expect(decodeURIComponent(request.pathname)).toContain(
          "/functions/NestedDurable-deployed/durable-executions",
        );
        expect(request.searchParams.get("DurableExecutionName")).toBe(
          "nested-runtime",
        );
        expect(request.searchParams.has("Qualifier")).toBe(false);
      }

      // The runtime resolves nested binding values during cold start. The
      // separate self-handle test below owns missing-runtime-identity coverage
      // using a fresh bundle import rather than mutating a warm runtime cache.
    }),
  { timeout: 60_000 },
);

test.provider(
  "uses Lambda runtime identity for self handles without self-dependent props",
  (stack) =>
    Effect.gen(function* () {
      reconciled.clear();

      const program = SelfDurable.pipe(Effect.provide(SelfDurableLive));
      const plan = yield* stack.plan(program);
      expect(plan.resources.SelfDurable).toBeDefined();

      yield* stack.deploy(program);
      const props = reconciled.get("SelfDurable");
      expect(props).toBeDefined();
      expect(Object.values(props?.env ?? {})).not.toContain(
        "SelfDurable-deployed",
      );

      const config = yield* resolveFunctionBundleConfig(props!, {
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
        prefix: "alchemy-self-durable-runtime-",
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
              return new Response('{"DurableExecutions":[]}', {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      );

      const runtimeEnv = {
        ...props?.env,
        ALCHEMY_AWS_ACCOUNT_ID: "123",
        ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify({
          lambda: server.url.origin,
        }),
        ALCHEMY_STACK_NAME: "self-durable-test",
        ALCHEMY_STAGE: "test",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_REGION: "us-east-1",
        AWS_LAMBDA_FUNCTION_NAME: "SelfDurable-runtime",
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
          event: { operation: "list" },
          context: object,
        ) => Promise<unknown>;
      };

      expect(
        yield* Effect.promise(() => module.default({ operation: "list" }, {})),
      ).toMatchObject({ DurableExecutions: [] });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("SelfDurable-runtime");

      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      const missingNameBundleDir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-self-durable-missing-name-",
      });
      yield* Effect.forEach(bundle.files, (file) =>
        fs.writeFile(
          path.join(missingNameBundleDir, file.path),
          typeof file.content === "string"
            ? new TextEncoder().encode(file.content)
            : file.content,
        ),
      );
      const missingNameEntry = path.join(
        missingNameBundleDir,
        bundle.files[0].path,
      );
      const missingNameModule = (yield* Effect.promise(
        () => import(pathToFileURL(missingNameEntry).href),
      )) as typeof module;
      const unresolved = yield* Effect.exit(
        Effect.tryPromise({
          try: () => missingNameModule.default({ operation: "list" }, {}),
          catch: (cause) => cause,
        }),
      );
      expect(Exit.isFailure(unresolved)).toBe(true);
      if (Exit.isFailure(unresolved)) {
        expect(Cause.pretty(unresolved.cause)).toContain(
          "AWS_LAMBDA_FUNCTION_NAME",
        );
      }
      expect(requests).toHaveLength(1);
    }),
  { timeout: 60_000 },
);
