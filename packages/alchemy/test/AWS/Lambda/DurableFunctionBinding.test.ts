import * as AWS from "@/AWS";
import type { FunctionProps, FunctionZipProps } from "@/AWS/Lambda/Function.ts";
import { makeFunctionBundler } from "@/AWS/Lambda/FunctionBundle.ts";
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
import SelfDurableLive, { SelfDurable } from "./fixtures/self-durable.ts";

const reconciled = new Map<string, FunctionProps>();
const reconciledBindings = new Map<
  string,
  ReadonlyArray<{ data?: { policyStatements?: ReadonlyArray<unknown> } }>
>();

const functionAttributes = (id: string): AWS.Lambda.Function["Attributes"] => ({
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
    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const desired = stripEffects(news);
      if (!isResolved(desired)) {
        return yield* Effect.die(
          new Error(`Function ${id} received unresolved props`),
        );
      }
      reconciled.set(id, desired);
      reconciledBindings.set(id, bindings);
      return output ?? functionAttributes(id);
    }),
    delete: () => Effect.void,
  });

const { test } = Test.make({
  providers: Layer.mergeAll(functionProvider(), Credentials.mock),
  state: inMemoryState(),
});

const writeBundle = (props: FunctionZipProps, prefix: string) =>
  Effect.gen(function* () {
    const bundler = yield* makeFunctionBundler;
    const plan = yield* bundler.resolveBundlePlan(props);
    const bundle = yield* Bundle.build(
      plan.inputOptions,
      plan.outputOptions,
      plan.extra,
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bundleDir = yield* fs.makeTempDirectoryScoped({ prefix });
    yield* Effect.forEach(bundle.files, (file) => {
      const output = path.join(bundleDir, file.path);
      return Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(output), { recursive: true });
        if (typeof file.content === "string") {
          yield* fs.writeFileString(output, file.content);
        } else {
          yield* fs.writeFile(output, file.content);
        }
      });
    });
    return path.join(bundleDir, bundle.files[0].path);
  });

const setRuntimeEnv = (env: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        Object.keys(env).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, env);
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );

const baseRuntimeEnv = (endpoint: string) => ({
  ALCHEMY_STACK_NAME: "durable-identity-test",
  ALCHEMY_STAGE: "test",
  AWS_ACCESS_KEY_ID: "test",
  AWS_ENDPOINT_URL: endpoint,
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test",
});

test.provider(
  "preserves nested and explicit DurableFunction identities at runtime",
  (stack) =>
    Effect.gen(function* () {
      reconciled.clear();
      reconciledBindings.clear();
      const program = NestedDurableParent.pipe(
        Effect.provide(NestedDurableParentLive),
      );

      const plan = yield* stack.plan(program);
      expect(plan.resources.NestedDurable.downstream).toContain(
        "NestedDurableParent",
      );

      yield* stack.deploy(program);
      const parent = reconciled.get("NestedDurableParent");
      expect(parent).toBeDefined();
      expect(Object.values(parent?.env ?? {})).toContain(
        "NestedDurable-deployed",
      );
      const parentPolicyStatements = reconciledBindings
        .get("NestedDurableParent")
        ?.flatMap((binding) => binding.data?.policyStatements ?? []);
      expect(parentPolicyStatements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Action: ["lambda:InvokeFunction"],
          }),
          expect.objectContaining({
            Action: ["lambda:ListDurableExecutionsByFunction"],
          }),
        ]),
      );

      const entry = yield* writeBundle(
        parent as FunctionZipProps,
        "alchemy-nested-durable-runtime-",
      );
      const requests: string[] = [];
      const exactNameLookups = new Map<string, number>();
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              requests.push(request.url);
              const url = new URL(request.url);
              if (url.pathname.endsWith("/invocations")) {
                const executionName = request.headers.get(
                  "x-amz-durable-execution-name",
                );
                return new Response("{}", {
                  status: 202,
                  headers: {
                    "content-type": "application/json",
                    ...(executionName === "direct-runtime"
                      ? {
                          "x-amz-durable-execution-arn":
                            "arn:aws:lambda:us-east-1:123:function:NestedDurable-deployed:1/durable-execution/direct-runtime",
                        }
                      : {}),
                  },
                });
              }

              const executionName = url.searchParams.get(
                "DurableExecutionName",
              );
              const lookup =
                (exactNameLookups.get(executionName ?? "") ?? 0) + 1;
              exactNameLookups.set(executionName ?? "", lookup);
              const execution = (name: string, suffix = name) => ({
                DurableExecutionArn: `arn:aws:lambda:us-east-1:123:function:NestedDurable-deployed:1/durable-execution/${suffix}`,
                DurableExecutionName: name,
                FunctionArn:
                  "arn:aws:lambda:us-east-1:123:function:NestedDurable-deployed:1",
                Status: "RUNNING",
                StartTimestamp: 1,
              });
              const executions =
                executionName === "nested-runtime" && lookup === 3
                  ? [execution("nested-runtime")]
                  : executionName === "ambiguous-runtime"
                    ? [
                        execution("ambiguous-runtime", "ambiguous-runtime-a"),
                        execution("ambiguous-runtime", "ambiguous-runtime-b"),
                      ]
                    : [];
              return Response.json({ DurableExecutions: executions });
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      );

      yield* setRuntimeEnv({
        ...baseRuntimeEnv(server.url.origin),
        ...(parent?.env as Record<string, string>),
      });
      const module = (yield* Effect.promise(
        () => import(`${pathToFileURL(entry).href}?nested-identity`),
      )) as {
        default: (
          event: {
            operation:
              | "start"
              | "direct-start"
              | "anonymous-start"
              | "missing-start"
              | "ambiguous-start"
              | "list"
              | "implicit-list";
          },
          context: object,
        ) => Promise<unknown>;
      };

      expect(
        yield* Effect.promise(() => module.default({ operation: "start" }, {})),
      ).toEqual({
        executionArn:
          "arn:aws:lambda:us-east-1:123:function:NestedDurable-deployed:1/durable-execution/nested-runtime",
        statusCode: 202,
      });
      expect(
        yield* Effect.promise(() =>
          module.default({ operation: "direct-start" }, {}),
        ),
      ).toEqual({
        executionArn:
          "arn:aws:lambda:us-east-1:123:function:NestedDurable-deployed:1/durable-execution/direct-runtime",
        statusCode: 202,
      });
      expect(
        yield* Effect.promise(() => module.default({ operation: "list" }, {})),
      ).toMatchObject({ DurableExecutions: [] });
      expect(
        yield* Effect.promise(() =>
          module.default({ operation: "implicit-list" }, {}),
        ),
      ).toMatchObject({ DurableExecutions: [] });
      expect(
        yield* Effect.promise(() =>
          module.default({ operation: "anonymous-start" }, {}),
        ),
      ).toEqual({ executionArn: undefined, statusCode: 202 });

      const missingStart = yield* Effect.exit(
        Effect.tryPromise({
          try: () => module.default({ operation: "missing-start" }, {}),
          catch: (cause) => cause,
        }),
      );
      expect(Exit.isFailure(missingStart)).toBe(true);
      if (Exit.isFailure(missingStart)) {
        expect(Cause.pretty(missingStart.cause)).toContain(
          "DurableExecutionIdentityUnavailable",
        );
      }

      const ambiguousStart = yield* Effect.exit(
        Effect.tryPromise({
          try: () => module.default({ operation: "ambiguous-start" }, {}),
          catch: (cause) => cause,
        }),
      );
      expect(Exit.isFailure(ambiguousStart)).toBe(true);
      if (Exit.isFailure(ambiguousStart)) {
        expect(Cause.pretty(ambiguousStart.cause)).toContain(
          "AmbiguousDurableExecutionIdentity",
        );
      }

      expect(requests).toHaveLength(14);
      expect(
        requests.every((request) => request.includes("NestedDurable-deployed")),
      ).toBe(true);
      const requestUrls = requests.map((request) => new URL(request));
      const invokeRequests = requestUrls.filter((request) =>
        request.pathname.endsWith("/invocations"),
      );
      expect(invokeRequests).toHaveLength(5);
      expect(
        invokeRequests.every(
          (request) => request.searchParams.get("Qualifier") === "live",
        ),
      ).toBe(true);
      for (const request of requestUrls.filter((request) =>
        request.pathname.includes("/durable-executions"),
      )) {
        expect(decodeURIComponent(request.pathname)).toContain(
          "/functions/NestedDurable-deployed:live/durable-executions",
        );
        expect(request.searchParams.has("Qualifier")).toBe(false);
      }
      expect(exactNameLookups.get("nested-runtime")).toBe(5);
      expect(exactNameLookups.get("missing-runtime")).toBe(3);
      expect(exactNameLookups.get("ambiguous-runtime")).toBe(1);
    }),
  { timeout: 120_000, exclusive: true },
);

test.provider(
  "reads self identity lazily from the Lambda runtime environment",
  (stack) =>
    Effect.gen(function* () {
      reconciled.clear();
      const program = SelfDurable.pipe(Effect.provide(SelfDurableLive));

      const plan = yield* stack.plan(program);
      expect(plan.resources.SelfDurable).toBeDefined();
      yield* stack.deploy(program);
      const props = reconciled.get("SelfDurable");
      expect(props).toBeDefined();
      const selfActions = reconciledBindings
        .get("SelfDurable")
        ?.flatMap((binding) => binding.data?.policyStatements ?? [])
        .flatMap((statement: any) => statement.Action ?? []);
      expect(selfActions).toEqual(
        expect.arrayContaining([
          "lambda:CheckpointDurableExecution",
          "lambda:InvokeFunction",
          "lambda:ListDurableExecutionsByFunction",
          "lambda:GetDurableExecution",
        ]),
      );
      expect(Object.values(props?.env ?? {})).not.toContain(
        "SelfDurable-deployed",
      );

      const entry = yield* writeBundle(
        props as FunctionZipProps,
        "alchemy-self-durable-runtime-",
      );
      const requests: string[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              requests.push(request.url);
              return new Response('{"DurableExecutions":[]}', {
                headers: { "content-type": "application/json" },
              });
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      );

      yield* setRuntimeEnv({
        ...baseRuntimeEnv(server.url.origin),
        ...(props?.env as Record<string, string>),
        AWS_LAMBDA_FUNCTION_NAME: "SelfDurable-runtime",
      });
      const module = (yield* Effect.promise(
        () => import(`${pathToFileURL(entry).href}?self-identity`),
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
      const missingEntry = yield* writeBundle(
        props as FunctionZipProps,
        "alchemy-self-durable-missing-name-",
      );
      const missingModule = (yield* Effect.promise(
        () =>
          import(`${pathToFileURL(missingEntry).href}?missing-self-identity`),
      )) as typeof module;
      const unresolved = yield* Effect.exit(
        Effect.tryPromise({
          try: () => missingModule.default({ operation: "list" }, {}),
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
  { timeout: 120_000, exclusive: true },
);
