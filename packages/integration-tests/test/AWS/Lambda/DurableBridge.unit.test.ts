import * as AWS from "@alchemy.run/aws";
import {
  encodeDurableEnvelope,
  readDurableInputPayload,
  wrapDurableContext,
} from "@alchemy.run/aws/Lambda/DurableBridge";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as SDK from "@aws/durable-execution-sdk-js";
import { Credentials } from "@distilled.cloud/aws";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import * as Provider from "alchemy/Provider";
import { inMemoryState } from "alchemy/State";
import type { Context as LambdaContext } from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({
  providers: Layer.mergeAll(
    Credentials.mock,
    Provider.succeed(AWS.Lambda.Function, {
      list: () => Effect.succeed([]),
      diff: () => Effect.succeed(undefined),
      precreate: () => Effect.die("This suite only plans; no provider writes"),
      reconcile: () => Effect.die("This suite only plans; no provider writes"),
      delete: () => Effect.void,
    }),
  ),
  state: inMemoryState(),
});

const lambdaContext: LambdaContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "callback-round-trip",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123:function:callback-round-trip:1",
  memoryLimitInMB: "128",
  awsRequestId: "callback-round-trip",
  logGroupName: "test",
  logStreamName: "test",
  getRemainingTimeInMillis: () => 60_000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

// The SDK owns all serialization and replay. This transport stores its wire
// operations and allows the real management sender to complete a callback.
const backend = () => {
  const operations = new Map<string, SDK.WireOperation>();
  const calls: SDK.OperationUpdate[] = [];
  const client: SDK.DurableExecutionClient = {
    getExecutionState: async () => ({ Operations: [...operations.values()] }),
    checkpoint: async ({ Updates }) => {
      for (const update of Updates ?? []) {
        calls.push(update);
        if (update.Id === undefined) throw new Error("SDK checkpoint has no operation id");
        const op: SDK.WireOperation = {
          ...operations.get(update.Id),
          Id: update.Id,
          Name: update.Name,
          ParentId: update.ParentId,
          Type: update.Type,
          SubType: update.SubType,
          StartTimestamp: new Date().toISOString(),
          Status: update.Action === "SUCCEED" ? "SUCCEEDED" : "STARTED",
        };
        if (update.Type === "STEP") op.StepDetails = { Result: update.Payload };
        if (update.Type === "CONTEXT") op.ContextDetails = { Result: update.Payload };
        if (update.Type === "CALLBACK") op.CallbackDetails = { CallbackId: update.Id };
        if (update.Type === "CHAINED_INVOKE") {
          op.Status = "SUCCEEDED";
          op.ChainedInvokeDetails = { Result: update.Payload };
        }
        operations.set(update.Id, op);
      }
      return {
        CheckpointToken: "token",
        NewExecutionState: { Operations: [...operations.values()] },
      };
    },
  };
  return { operations, calls, client };
};

// The optional-SDK bridge models wire semantics as strings. Adapt the SDK's
// nominal enum at the test boundary rather than asserting the context type.
const bridgeContext = (context: SDK.DurableContext) =>
  wrapDurableContext(
    {
      lambdaContext: context.lambdaContext,
      executionContext: context.executionContext,
      invoke: context.invoke.bind(context),
      wait: context.wait.bind(context),
      waitForCallback: context.waitForCallback.bind(context),
      step: (name, fn, config) =>
        context.step(name, fn, {
          retryStrategy: config?.retryStrategy,
          semantics:
            config?.semantics === undefined
              ? undefined
              : config.semantics === "AT_MOST_ONCE_PER_RETRY"
                ? SDK.StepSemantics.AtMostOncePerRetry
                : SDK.StepSemantics.AtLeastOncePerRetry,
        }),
    },
    SDK.defaultSerdes,
  );

const values: unknown[] = [
  { allowed: false, reason: "quota", nested: { count: 2 }, items: [1, "x"] },
  '{"looks":"like JSON but is a string"}',
  "plain string",
  "",
  null,
  false,
  0,
  undefined,
];

test.provider(
  "callback success round-trips JSON once through SDK waitForCallback and replay",
  (stack) =>
    Effect.gen(function* () {
      const handles: AWS.Lambda.DurableFunctionHandle[] = [];
      let wire: string | undefined;
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            async fetch(request) {
              wire = await request.text();
              return Response.json({});
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      );
      yield* stack
        .plan(
          AWS.Lambda.DurableFunction(
            "CallbackRoundTrip",
            { main: import.meta.url },
            Effect.gen(function* () {
              handles.push(yield* AWS.Lambda.DurableFunctionScope);
              return () => Effect.void;
            }),
          ),
        )
        .pipe(Effect.provideService(Endpoint, Effect.succeed(server.url.origin)));
      const handle = handles[0];
      if (handle === undefined) return yield* Effect.die("Durable handle was not initialized");
      for (const { value, omitResult } of [
        ...values.map((value) => ({ value, omitResult: false })),
        { value: undefined, omitResult: true },
      ]) {
        const state = backend();
        let callbackId: string | undefined;
        let submissions = 0;
        const observed: unknown[] = [];
        const run = SDK.withDurableExecution(
          async (_input, context) => {
            const bridge = bridgeContext(context);
            const result = await Effect.runPromise(
              bridge.waitForCallback({
                name: "approval",
                submitter: (id) =>
                  Effect.sync(() => {
                    callbackId = id;
                    submissions++;
                  }),
              }),
            );
            observed.push(result);
            return result;
          },
          { durableExecutionClient: state.client },
        );
        const event = (): SDK.DurableExecutionInvocationInput => ({
          DurableExecutionArn: `${lambdaContext.invokedFunctionArn}/durable-execution/test`,
          CheckpointToken: "token",
          InitialExecutionState: { Operations: [...state.operations.values()] },
        });
        expect((yield* Effect.promise(() => run(event(), lambdaContext))).Status).toBe("PENDING");
        if (callbackId === undefined) return yield* Effect.die("SDK did not create a callback");
        yield* handle.sendCallbackSuccess(callbackId, value);
        expect(wire).toBe(value === undefined ? "" : JSON.stringify(value));
        const callback = state.operations.get(callbackId);
        if (callback === undefined) return yield* Effect.die("Callback checkpoint is missing");
        state.operations.set(callbackId, {
          ...callback,
          Status: "SUCCEEDED",
          CallbackDetails: { CallbackId: callbackId, Result: omitResult ? undefined : wire },
        });
        expect((yield* Effect.promise(() => run(event(), lambdaContext))).Status).toBe("SUCCEEDED");
        // The completed wait's child context is itself checkpointed. Replaying
        // that parent must deserialize once too, without rerunning submitter.
        expect((yield* Effect.promise(() => run(event(), lambdaContext))).Status).toBe("SUCCEEDED");
        expect(observed).toEqual([value, value]);
        expect(submissions).toBe(1);
      }
    }),
  { timeout: 120_000, exclusive: true },
);

test(
  "step, invoke, child-context and start-envelope JSON remain symmetric on execution and replay",
  Effect.gen(function* () {
    for (const value of values) {
      const state = backend();
      let stepRuns = 0;
      let childRuns = 0;
      const observed: unknown[] = [];
      const input = { $alchemy: { workflow: "RoundTrip" }, params: value };
      const inputOperation: SDK.WireOperation = {
        Id: "execution",
        Type: "EXECUTION",
        Status: "STARTED",
        StartTimestamp: new Date().toISOString(),
        ExecutionDetails: { InputPayload: encodeDurableEnvelope("RoundTrip", value) },
      };
      const run = SDK.withDurableExecution(
        async (event, context) => {
          expect(event).toEqual(input);
          const bridge = bridgeContext(context);
          const result = await Effect.runPromise(
            bridge.step({
              name: "step",
              effect: Effect.sync(() => {
                stepRuns++;
                return value;
              }),
            }),
          );
          const invoked = await Effect.runPromise(bridge.invoke("invoke", "echo", value));
          const child = await context.runInChildContext("child", async () => {
            childRuns++;
            return value;
          });
          observed.push(result, invoked, child);
          return value;
        },
        { durableExecutionClient: state.client },
      );
      const event = (): SDK.DurableExecutionInvocationInput => ({
        DurableExecutionArn: `${lambdaContext.invokedFunctionArn}/durable-execution/audit`,
        CheckpointToken: "token",
        InitialExecutionState: { Operations: [inputOperation, ...state.operations.values()] },
      });
      expect(readDurableInputPayload(event())).toEqual(input);
      expect((yield* Effect.promise(() => run(event(), lambdaContext))).Status).toBe("SUCCEEDED");
      expect((yield* Effect.promise(() => run(event(), lambdaContext))).Status).toBe("SUCCEEDED");
      expect(observed).toEqual([value, value, value, value, value, value]);
      expect(stepRuns).toBe(1);
      expect(childRuns).toBe(1);
      expect(state.calls.find((op) => op.Type === "CHAINED_INVOKE")?.Payload).toBe(
        JSON.stringify(value),
      );
    }
  }),
  { timeout: 120_000 },
);
