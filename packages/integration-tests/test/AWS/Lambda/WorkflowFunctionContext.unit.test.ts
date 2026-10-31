import { expect, test } from "bun:test";
import {
  DurableExecutionContext,
  DurableStep,
  DurableStepAttempt,
} from "@alchemy.run/aws/Lambda/Durable";
import type {
  DurableFunctionInitServices,
  DurableFunctionScope,
} from "@alchemy.run/aws/Lambda/DurableFunction";
import { HandlerContext } from "@alchemy.run/aws/Lambda/InvocationDeadline";
import {
  ActivityRetry,
  DeferredWaitFailure,
  makeWorkflowEngine,
  makeWorkflowRunner,
} from "@alchemy.run/aws/Lambda/WorkflowFunction";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { decodeResult, encodeExit, CurrentActivity } from "alchemy/WorkflowEncoding";
import * as Workflows from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import { readInline, ActivityContextResult } from "./fixtures/workflow-floci/activity-context.ts";

// The function provides its self handle during init; callers must not supply it.
const selfHandleProvided: Exclude<DurableFunctionScope, DurableFunctionInitServices> extends never
  ? true
  : false = true;
expect(selfHandleProvided).toBe(true);

class RetryFailure extends Schema.TaggedError<RetryFailure>()("RetryFailure", {
  retryable: Schema.Boolean,
}) {}

const workflow = Workflow.make("ContextProbe", {
  payload: { id: Schema.String },
  success: Schema.Void,
  idempotencyKey: ({ id }) => id,
});
const parent = Workflow.make("ContextParent", {
  payload: { id: Schema.String },
  success: Schema.Void,
  idempotencyKey: ({ id }) => id,
});
const executionArn =
  "arn:aws:lambda:us-west-2:123:function:context-probe:7/durable-execution/probe";
const telemetry = () => {
  const lines: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
  const spans: Array<{ name: string; spanId: string; parent: string | undefined }> = [];
  return {
    lines,
    spans,
    logger: Logger.make((options) =>
      lines.push({
        message: options.message,
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
      }),
    ),
    tracer: Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push({
          name: options.name,
          spanId: span.spanId,
          parent: Option.getOrUndefined(Option.map(options.parent, (p) => p.spanId)),
        });
        return span;
      },
    }),
  };
};
const withTelemetry =
  (record: ReturnType<typeof telemetry>, name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([record.logger])),
      Effect.provideService(Tracer.Tracer, record.tracer),
      Effect.provideService(References.CurrentLogAnnotations, { provenance: name }),
      Effect.provideService(
        Tracer.ParentSpan,
        Tracer.externalSpan({ spanId: `${name}-parent`, traceId: `${name}-trace` }),
      ),
    );

for (const mode of ["engine", "runner"] as const) {
  test(`retains caller telemetry and boot AWS authority in ${mode} SDK calls`, async () => {
    const boot = telemetry();
    const caller = telemetry();
    const requests: Array<{
      pathname: string;
      qualifier: string | null;
      host: string;
      authorization: string | undefined;
    }> = [];
    const services = Layer.mergeAll(
      Layer.succeed(
        Credentials,
        Effect.succeed({
          accessKeyId: Redacted.make("boot-key"),
          secretAccessKey: Redacted.make("boot-secret"),
          sessionToken: undefined,
          region: "us-east-1",
        }),
      ),
      Layer.succeed(Region, Effect.succeed("us-west-2")),
      Layer.succeed(Endpoint, Effect.succeed("https://boot-transport.test")),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, url) =>
          Effect.gen(function* () {
            requests.push({
              pathname: url.pathname,
              qualifier: url.searchParams.get("Qualifier"),
              host: url.host,
              authorization: request.headers.authorization,
            });
            yield* Effect.logInfo("transport accepted invoke");
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: 202,
                headers: { "x-amz-durable-execution-arn": executionArn },
              }),
            );
          }).pipe(Effect.withSpan("transport.invoke")),
        ),
      ),
    );
    const assertTelemetry = () => {
      expect(boot.lines).toEqual([]);
      expect(boot.spans).toEqual([]);
      expect(caller.lines).toContainEqual({
        message: ["transport accepted invoke"],
        annotations: { provenance: "caller" },
      });
      const transport = caller.spans.find((s) => s.name === "transport.invoke");
      expect(transport).toBeDefined();
      const execute = caller.spans.find((s) => s.name === "ContextProbe.execute");
      expect(execute).toBeDefined();
      expect(transport!.parent).toBe(execute!.spanId);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        pathname: "/2015-03-31/functions/context-probe/invocations",
        qualifier: "7",
        host: "boot-transport.test",
      });
      expect(requests[0]!.authorization).toContain("Credential=boot-key/");
      expect(requests[0]!.authorization).toContain("/us-west-2/lambda/aws4_request");
    };
    if (mode === "engine") {
      const engine = await Effect.runPromise(
        makeWorkflowEngine("context-probe", "7").pipe(
          Effect.provide(services),
          withTelemetry(boot, "boot"),
        ),
      );
      await Effect.runPromise(
        workflow
          .execute({ id: "probe" }, { discard: true })
          .pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            withTelemetry(caller, "caller"),
          ),
      );
      assertTelemetry();
      expect(caller.spans).toContainEqual(
        expect.objectContaining({ name: "ContextProbe.execute", parent: "caller-parent" }),
      );
    } else {
      const previousName = process.env.AWS_LAMBDA_FUNCTION_NAME;
      const previousVersion = process.env.AWS_LAMBDA_FUNCTION_VERSION;
      process.env.AWS_LAMBDA_FUNCTION_NAME = "context-probe";
      process.env.AWS_LAMBDA_FUNCTION_VERSION = "7";
      try {
        class InvocationService extends Context.Service<InvocationService, string>()(
          "InvocationService",
        ) {}
        const implementations = Layer.mergeAll(
          Workflows.layer(workflow, () => Effect.void),
          Workflows.layer(parent, () =>
            Effect.gen(function* () {
              yield* workflow.execute({ id: "child" }, { discard: true });
              expect(yield* readInline).toEqual({
                value: "present",
                workflow: "ContextParent",
                sameExecution: true,
                isolated: true,
                interrupted: false,
                attempt: 1,
              });
              for (const retryable of [false, true]) {
                let attempts = 0;
                const result = yield* Activity.make({
                  name: `predicate-${retryable}`,
                  error: RetryFailure,
                  execute: Effect.suspend(() => {
                    attempts += 1;
                    return Effect.fail(new RetryFailure({ retryable }));
                  }),
                })
                  .annotate(ActivityRetry, {
                    limit: 2,
                    while: (error) => {
                      expect(error).toBeInstanceOf(RetryFailure);
                      return error instanceof RetryFailure && error.retryable;
                    },
                  })
                  .pipe(Effect.flip);
                expect(result).toBeInstanceOf(RetryFailure);
                expect(result.retryable).toBe(retryable);
                expect(attempts).toBe(retryable ? 3 : 1);
              }
              for (const mode of ["timeout", "external", "domain", "unknown"] as const) {
                const deferred = DurableDeferred.make(`native-${mode}`, {
                  error: Schema.Union([DeferredWaitFailure, RetryFailure]),
                });
                const exit = yield* Effect.exit(DurableDeferred.await(deferred));
                expect(Exit.isFailure(exit)).toBe(true);
                if (Exit.isFailure(exit)) {
                  const error = Cause.findErrorOption(exit.cause);
                  if (mode === "unknown") {
                    expect(Cause.squash(exit.cause)).toEqual({
                      errorType: "EngineInvariantBroken",
                    });
                  } else {
                    expect(Option.isSome(error)).toBe(true);
                    if (Option.isSome(error)) {
                      if (mode === "domain") expect(error.value).toBeInstanceOf(RetryFailure);
                      else {
                        expect(error.value).toBeInstanceOf(DeferredWaitFailure);
                        expect((error.value as DeferredWaitFailure).kind).toBe(
                          mode === "timeout" ? "timed_out" : "failed",
                        );
                      }
                    }
                  }
                }
              }
              let defectAttempts = 0;
              const defectExit = yield* Activity.make({
                name: "predicate-defect",
                execute: Effect.suspend(() => {
                  defectAttempts += 1;
                  return Effect.die(new Error("unretryable defect"));
                }),
              })
                .annotate(ActivityRetry, { limit: 2, while: () => true })
                .pipe(Effect.exit);
              expect(Exit.isFailure(defectExit)).toBe(true);
              expect(defectAttempts).toBe(1);
              yield* Activity.make({
                name: "activity",
                execute: Effect.gen(function* () {
                  expect(yield* InvocationService).toBe("invocation-value");
                  expect(yield* Activity.CurrentAttempt).toBe(4);
                  expect(yield* DurableStepAttempt).toBe(3);
                  expect(yield* CurrentActivity).toMatchObject({
                    workflow: "ContextParent",
                    executionId: "parent",
                    activity: "activity",
                  });
                  yield* Effect.logInfo("activity body");
                }).pipe(
                  Effect.annotateLogs({ activity: "scoped" }),
                  Effect.withSpan("activity.body"),
                ),
              }).pipe(
                Effect.provideService(Activity.CurrentAttempt, 2),
                Effect.provideService(DurableStepAttempt, 99),
              );
            }),
          ),
        );
        const runner = await Effect.runPromise(
          makeWorkflowRunner(implementations).pipe(
            Effect.provide(services),
            withTelemetry(boot, "boot"),
          ),
        );
        const unscripted = () => Effect.die("unscripted durable operation");
        const durable: DurableStep["Service"] = {
          step: (options) =>
            Effect.gen(function* () {
              for (let retry = 0; ; retry += 1) {
                const exit = yield* Effect.exit(
                  options.effect.pipe(
                    Effect.provideService(
                      DurableStepAttempt,
                      options.name.startsWith("activity/") ? 3 : 1,
                    ),
                  ),
                );
                if (Exit.isSuccess(exit)) return exit.value;
                const defect = Cause.squash(exit.cause);
                if (
                  retry < (options.retry?.limit ?? 0) &&
                  defect instanceof Error &&
                  options.retryWhen?.(defect)
                )
                  continue;
                return yield* Effect.failCause(exit.cause);
              }
            }),
          invoke: unscripted,
          wait: unscripted,
          waitForCallback: (options) => {
            if (options.name === "native-timeout")
              return Effect.die({ errorType: "CallbackTimeoutError" });
            if (options.name === "native-unknown")
              return Effect.die({ errorType: "EngineInvariantBroken" });
            const exit =
              options.name === "native-domain"
                ? Exit.fail(Schema.encodeSync(RetryFailure)(new RetryFailure({ retryable: false })))
                : Exit.die(
                    new Error("external rejection", {
                      cause: { errorType: "CallbackExternalError" },
                    }),
                  );
            return encodeExit(exit).pipe(
              Effect.flatMap((text) => Effect.die(new Error(`alchemy/DeferredFailure:${text}`))),
            );
          },
        };
        const encoded = await Effect.runPromise(
          runner({
            workflow: "ContextParent",
            executionId: "parent",
            payload: { id: "parent" },
          }).pipe(
            Effect.provideService(DurableStep, durable),
            Effect.provideService(DurableExecutionContext, { executionArn }),
            Effect.provideService(HandlerContext, {
              callbackWaitsForEmptyEventLoop: false,
              functionName: "context-probe",
              functionVersion: "7",
              invokedFunctionArn: "arn:aws:lambda:us-west-2:123:function:context-probe:7",
              memoryLimitInMB: "128",
              awsRequestId: "request",
              logGroupName: "group",
              logStreamName: "stream",
              getRemainingTimeInMillis: () => 60_000,
              done: () => {
                throw new Error("unscripted HandlerContext.done");
              },
              fail: () => {
                throw new Error("unscripted HandlerContext.fail");
              },
              succeed: () => {
                throw new Error("unscripted HandlerContext.succeed");
              },
            }),
            Effect.provideService(RuntimeContext, {
              Type: "test",
              id: "context-probe",
              env: {},
              get: () => Effect.die("unscripted runtime get"),
              set: () => Effect.die("unscripted runtime set"),
            }),
            Effect.scoped,
            Effect.provideService(InvocationService, "invocation-value"),
            withTelemetry(caller, "caller"),
          ),
        );
        const completed = await Effect.runPromise(decodeResult(parent, encoded));
        expect(Exit.isSuccess(completed.exit)).toBe(true);
        assertTelemetry();
        expect(caller.lines).toContainEqual({
          message: ["inline activity body"],
          annotations: { provenance: "caller", inline: "present" },
        });
        const inlineSpan = caller.spans.find((s) => s.name === "inline.callsite");
        expect(inlineSpan?.parent).toBe("caller-parent");
        expect(caller.lines).toContainEqual({
          message: ["activity body"],
          annotations: { provenance: "caller", activity: "scoped" },
        });
        const activitySpan = caller.spans.find((s) => s.name === "activity");
        expect(activitySpan).toBeDefined();
        expect(activitySpan!.parent).toBe("caller-parent");
        expect(caller.spans).toContainEqual(
          expect.objectContaining({ name: "activity.body", parent: activitySpan!.spanId }),
        );
      } finally {
        if (previousName === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
        else process.env.AWS_LAMBDA_FUNCTION_NAME = previousName;
        if (previousVersion === undefined) delete process.env.AWS_LAMBDA_FUNCTION_VERSION;
        else process.env.AWS_LAMBDA_FUNCTION_VERSION = previousVersion;
      }
    }
  });
}

test("memory engine preserves the same inline Activity services and instance contract", async () => {
  const memory = Workflow.make("MemoryContext", {
    payload: { id: Schema.String },
    success: ActivityContextResult,
    idempotencyKey: ({ id }) => id,
  });
  const result = await Effect.runPromise(
    memory
      .execute({ id: "memory" })
      .pipe(
        Effect.provide(Workflows.layer(memory, () => readInline)),
        Effect.provide(WorkflowEngine.layerMemory),
        Effect.scoped,
      ),
  );
  expect(result).toEqual({
    value: "present",
    workflow: "MemoryContext",
    sameExecution: true,
    isolated: true,
    interrupted: false,
    attempt: 1,
  });
});
