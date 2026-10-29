import { expect, test } from "bun:test";
import { DurableExecutionContext, DurableStep } from "@alchemy.run/aws/Lambda/Durable";
import { HandlerContext } from "@alchemy.run/aws/Lambda/InvocationDeadline";
import { makeWorkflowEngine, makeWorkflowRunner } from "@alchemy.run/aws/Lambda/WorkflowFunction";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Workflows from "alchemy/Workflows";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { Activity, Workflow, WorkflowEngine } from "effect/workflow";

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
              yield* Activity.make({
                name: "activity",
                execute: Effect.gen(function* () {
                  expect(yield* InvocationService).toBe("invocation-value");
                  yield* Effect.logInfo("activity body");
                }).pipe(
                  Effect.annotateLogs({ activity: "scoped" }),
                  Effect.withSpan("activity.body"),
                ),
              });
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
          step: (options) => Effect.promise(() => Effect.runPromise(options.effect)),
          invoke: unscripted,
          wait: unscripted,
          waitForCallback: unscripted,
        };
        await Effect.runPromise(
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
        assertTelemetry();
        expect(caller.lines).toContainEqual({
          message: ["activity body"],
          annotations: { provenance: "caller", activity: "scoped" },
        });
        expect(caller.spans).toContainEqual(
          expect.objectContaining({ name: "activity.body", parent: "caller-parent" }),
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
