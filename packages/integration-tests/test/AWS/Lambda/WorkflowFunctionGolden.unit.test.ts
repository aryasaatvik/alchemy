import {
  encodeDurableEnvelope,
  readDurableInputPayload,
} from "@alchemy.run/aws/Lambda/DurableBridge";
import { executionNameOf, makeWorkflowEngine } from "@alchemy.run/aws/Lambda/WorkflowFunction";
import { expect, it } from "@alchemy.run/test";
import { encodeExit, encodeResult } from "alchemy/WorkflowEncoding";
import * as Workflows from "alchemy/Workflows";
import { Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { WorkflowEngine } from "effect/workflow";
import { golden } from "./fixtures/workflow-floci/beta85-golden.ts";
import { services } from "./fixtures/workflow-floci/services.ts";
import { Approval, Probe, Rejected } from "./fixtures/workflow-floci/workflows.ts";

const functionArn = "arn:aws:lambda:us-east-1:000000000000:function:golden:1";
const durableArn = `${functionArn}/durable-execution/${golden.start.name}-execution`;
const execution = {
  DurableExecutionArn: durableArn,
  DurableExecutionName: golden.start.name,
  FunctionArn: functionArn,
  StartTimestamp: new Date(0).toISOString(),
  Status: "RUNNING",
};
type EventFixture = { readonly EventType: string; readonly EventId: number };

const harness = (
  options: {
    readonly history?: ReadonlyArray<EventFixture>;
    readonly result?: string;
    readonly secondArn?: string;
  } = {},
) => {
  const requests: {
    method: string;
    path: string;
    query: URLSearchParams;
    body?: string;
    name?: string;
  }[] = [];
  const http = HttpClient.make((request, url) => {
    expect(url.origin).toBe("http://127.0.0.1:0");
    const path = decodeURIComponent(url.pathname);
    const body =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined;
    const name = request.headers["x-amz-durable-execution-name"];
    requests.push({ method: request.method, path, query: url.searchParams, body, name });
    let response: Response;
    if (path.endsWith("/invocations")) {
      response = new Response(null, {
        status: 202,
        headers: { "x-amz-durable-execution-arn": durableArn },
      });
    } else if (path.endsWith("/history")) {
      const history = options.history ?? [];
      const reverse = url.searchParams.get("ReverseOrder") === "true";
      // Split parent and callback across pages to exercise reverse history discovery.
      response = Response.json(
        reverse && history.length > 1
          ? url.searchParams.has("Marker")
            ? { Events: history.slice(0, 1) }
            : { Events: history.slice(1).toReversed(), NextMarker: "parent" }
          : { Events: history },
      );
    } else if (path.includes("/functions/") && path.endsWith("/durable-executions")) {
      response = Response.json(
        url.searchParams.has("Marker")
          ? {
              DurableExecutions: [
                { ...execution, DurableExecutionArn: options.secondArn ?? durableArn },
              ],
            }
          : { DurableExecutions: [], NextMarker: "second-page" },
      );
    } else if (path.includes("/durable-execution-callbacks/")) {
      response = Response.json({});
    } else if (path.endsWith("/stop")) {
      response = Response.json({ StopTimestamp: new Date(0).toISOString() });
    } else if (path.endsWith(durableArn)) {
      response = Response.json({
        ...execution,
        Status: options.result === undefined ? "RUNNING" : "SUCCEEDED",
        Result: options.result,
      });
    } else {
      return Effect.die(new Error(`Unexpected durable request ${request.method} ${path}`));
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const engine = Effect.runPromise(
    makeWorkflowEngine("golden", "live").pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(services("http://127.0.0.1:0")),
    ),
  );
  return { run, engine, requests };
};

it("reproduces beta.85 execution names, native envelope and workflow Invoke bytes", async () => {
  const { run, engine, requests } = harness();
  const client = await run(
    Workflows.RunWorkflow(Probe).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, await engine),
      Effect.provideService(Workflows.Implemented("Probe"), true),
    ),
  );
  const started = await run(client.start({ id: "gold-success", mode: "success" }));
  expect(started.executionId).toBe(golden.id);
  expect(started.executionRef).toBe(durableArn);
  expect(requests[0]?.body).toBe(golden.start.body);
  expect(requests[0]?.name).toBe(golden.start.name);
  expect(requests[0]?.query.get("Qualifier")).toBe(golden.start.qualifier);
  for (const { workflow, id, name } of golden.names)
    expect(executionNameOf(workflow, id)).toBe(name);
  const params = { text: '["already JSON"]', count: 3 };
  expect(encodeDurableEnvelope("Golden", params)).toBe(golden.native);
  expect(
    readDurableInputPayload({
      DurableExecutionArn: durableArn,
      CheckpointToken: "golden-checkpoint",
      InitialExecutionState: {
        Operations: [{ Type: "EXECUTION", ExecutionDetails: { InputPayload: golden.native } }],
      },
    }),
  ).toEqual(JSON.parse(golden.native));
});

for (const mode of ["success", "fail"] as const) {
  it(`replays beta.85 ${mode} callback history and emits the same request bytes`, async () => {
    const result = mode === "success" ? golden.success : golden.failure;
    const { run, engine, requests } = harness({
      history: golden.histories[mode].slice(0, 2),
      result,
    });
    const saved = Workflows.makeRun(await engine, Probe, golden.id, durableArn);
    const rejected = new Rejected({ reason: "no" });
    const exit = mode === "success" ? Exit.succeed("approved") : Exit.fail(rejected);
    await run(saved.complete(Approval, exit));
    const sends = requests.filter((request) =>
      request.path.includes("/durable-execution-callbacks/"),
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toBe(golden.callback[mode]);
    expect(requests.filter((request) => request.path.endsWith("/history"))).toHaveLength(2);
    expect(JSON.stringify(await run(encodeResult(Probe, exit)))).toBe(result);
    expect(await run(saved.status)).toEqual(
      mode === "success"
        ? { _tag: "Completed", result: "approved" }
        : { _tag: "Failed", error: rejected },
    );
    expect(requests.some((request) => request.path.endsWith("/durable-executions"))).toBe(false);
  });
}

it("reproduces the typed beta.85 NotYetWaiting result for completed callback history", async () => {
  const { run, engine, requests } = harness({ history: golden.histories.success });
  const { executionId } = golden.notYetWaiting;
  const saved = Workflows.makeRun(await engine, Probe, executionId, durableArn);
  const failure = await run(Effect.flip(saved.complete(Approval, Exit.succeed("late"))));
  expect(JSON.parse(JSON.stringify(failure))).toEqual(golden.notYetWaiting);
  expect(requests.some((request) => request.method === "POST")).toBe(false);
});

it("interrupts beta.85 WaitStarted sleepers and resumes old suspended activities", async () => {
  const clock = harness({ history: golden.histories.clock.slice(0, 1) });
  await clock.run(Workflows.makeRun(await clock.engine, Probe, golden.id, durableArn).interrupt);
  expect(clock.requests.some((request) => request.path.endsWith("/stop"))).toBe(true);
  const suspend = harness({ history: golden.histories.suspension });
  await suspend.run((await suspend.engine).resume(Probe, golden.id));
  expect(
    suspend.requests
      .filter((request) => request.path.endsWith("/durable-executions"))
      .map((request) => request.query.has("Qualifier")),
  ).toEqual([false, false]);
  const sends = suspend.requests.filter((request) =>
    request.path.includes("/durable-execution-callbacks/"),
  );
  expect(sends).toHaveLength(1);
  expect(sends[0]?.body).toBe("{}");
  expect(
    golden.histories.suspension.some(
      (event) =>
        event.EventType === "StepStarted" && "Name" in event && event.Name === "suspension/1",
    ),
  ).toBe(true);
  expect(await suspend.run(encodeExit(Exit.succeed("approved")))).toBe(golden.callback.success);
});
