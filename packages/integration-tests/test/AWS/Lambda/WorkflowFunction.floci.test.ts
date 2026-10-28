/** Focused real-engine tests. Own Floci instance required; never defaults to a shared endpoint. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeWorkflowEngine } from "@alchemy.run/aws/Lambda/WorkflowFunction";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Workflows from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { DurableDeferred, WorkflowEngine } from "effect/workflow";
import { services } from "./fixtures/workflow-floci/services.ts";
import { Approval, LoopApprovals, Probe, Rejected } from "./fixtures/workflow-floci/workflows.ts";

const endpoint = process.env.WORKFLOW_FLOCI_ENDPOINT;
const name = `alchemy-workflow-pr3-${crypto.randomUUID().slice(0, 8)}`;
const layer = services(endpoint ?? "http://127.0.0.1:0");
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);
let directory: string;
let engine: WorkflowEngine.WorkflowEngine["Service"];

const result = (arn: string) =>
  run(
    Lambda.getDurableExecution({ DurableExecutionArn: arn }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (r) => r.Status !== "RUNNING",
        times: 100,
      }),
    ),
  );
const start = async (mode: string) => {
  const payload = { id: `${mode}-${crypto.randomUUID()}`, mode };
  const client = await run(
    Workflows.RunWorkflow(Probe).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      Effect.provideService(Workflows.Implemented("Probe"), true),
    ),
  );
  return { ...(await run(client.start(payload))), payload };
};
const events = (arn: string) =>
  run(
    Lambda.getDurableExecutionHistory.items({ DurableExecutionArn: arn }).pipe(Stream.runCollect),
  );
const counts: Record<string, Record<string, number>> = {};
const measure = async (mode: string, arn: string) => {
  const history = [...(await events(arn))];
  const operations = new Map(
    history
      .filter((e) => e.Id)
      .map((e) => [e.Id, e.EventType?.replace(/(Started|Succeeded|Failed|TimedOut|Stopped)$/, "")]),
  );
  counts[mode] = [...operations.values()].reduce<Record<string, number>>((a, type) => {
    a[type ?? "unknown"] = (a[type ?? "unknown"] ?? 0) + 1;
    return a;
  }, {});
};

interface RequestReceipt {
  readonly url: string;
  readonly params: Record<string, string | Redacted.Redacted<string>>;
}
const completionCounts: Record<string, { history: number; list: number; sends: number }> = {};
const measuredEngine = (requests: RequestReceipt[]) =>
  run(
    makeWorkflowEngine(name, "1").pipe(
      Effect.updateService(HttpClient.HttpClient, (client) =>
        HttpClient.mapRequest(client, (request) => {
          const url = new URL(request.url);
          requests.push({
            url: `${url.origin}${url.pathname}`,
            params: Object.fromEntries([...url.searchParams, ...request.urlParams]),
          });
          return request;
        }),
      ),
    ),
  );
const recordCompletion = (label: string, requests: RequestReceipt[], withRef: boolean) => {
  const history = requests.filter((r) => r.url.endsWith("/history"));
  completionCounts[label] = {
    history: history.length,
    list: requests.filter(
      (r) => r.url.includes("/functions/") && r.url.endsWith("/durable-executions"),
    ).length,
    sends: requests.filter((r) => r.url.includes("/durable-execution-callbacks/")).length,
  };
  expect(completionCounts[label]!.list).toBe(withRef ? 0 : 1);
  for (const request of history) {
    expect(request.params.ReverseOrder).toBe("true");
    expect(request.params.MaxItems).toBe("20");
  }
  return completionCounts[label]!;
};
const awaitCallback = async (arn: string, deferredName: string) => {
  await run(
    Lambda.getDurableExecutionHistory.items({ DurableExecutionArn: arn }).pipe(
      Stream.runCollect,
      Effect.repeat({
        schedule: Schedule.spaced("200 millis"),
        times: 100,
        until: (events) => {
          const history = [...events];
          const parent = history.find(
            (e) => e.SubType === "WaitForCallback" && e.Name === deferredName,
          )?.Id;
          return history.some(
            (e) => e.CallbackStartedDetails && (e.ParentId === parent || e.Name === deferredName),
          );
        },
      }),
      Effect.tap((events) =>
        Effect.sync(() => {
          const history = [...events];
          const parent = history.find(
            (e) => e.SubType === "WaitForCallback" && e.Name === deferredName,
          )?.Id;
          expect(
            history.some(
              (e) => e.CallbackStartedDetails && (e.ParentId === parent || e.Name === deferredName),
            ),
          ).toBe(true);
        }),
      ),
    ),
  );
};
const assertNotWaiting = async (
  effect: Effect.Effect<void, Workflows.NotYetWaiting>,
  deferredName: string,
) => {
  const exit = await run(Effect.exit(effect));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = exit.cause.reasons.find((r) => r._tag === "Fail");
    expect(failure?._tag === "Fail" && failure.error).toBeInstanceOf(Workflows.NotYetWaiting);
    if (failure?._tag === "Fail") expect(failure.error.deferredName).toBe(deferredName);
  }
};

describe.skipIf(!endpoint)("WorkflowFunction on isolated Floci", () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "alchemy-workflow-pr3-"));
    await run(S3.createBucket({ Bucket: "pr3-workflow-attempts" }));
    // Resolve from the workspace's pinned SDK, not from the network.
    const sdkEntry = path.resolve(
      import.meta.dirname,
      "../../../../../node_modules/.pnpm/@aws+durable-execution-sdk-js@2.6.0/node_modules/@aws/durable-execution-sdk-js/dist/index.mjs",
    );
    for (const [entry, outfile, external] of [
      [
        path.join(import.meta.dirname, "fixtures/workflow-floci/runtime.ts"),
        "index.mjs",
        ["@aws/durable-execution-sdk-js"],
      ],
      [sdkEntry, "node_modules/@aws/durable-execution-sdk-js/index.mjs", []],
    ] as const) {
      const built = await Bun.build({
        entrypoints: [entry],
        target: "node",
        external: [...external],
        minify: false,
      });
      if (!built.success) throw new AggregateError(built.logs);
      const target = path.join(directory, outfile);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await built.outputs[0]!.text());
    }
    await writeFile(
      path.join(directory, "node_modules/@aws/durable-execution-sdk-js/package.json"),
      JSON.stringify({ type: "module", main: "index.mjs" }),
    );
    execFileSync("zip", ["-qr", "function.zip", "index.mjs", "node_modules"], { cwd: directory });
    await run(
      Lambda.createFunction({
        FunctionName: name,
        Runtime: "nodejs22.x",
        Handler: "index.handler",
        Role: "arn:aws:iam::000000000000:role/pr3",
        Timeout: 60,
        Code: {
          ZipFile: new Uint8Array(
            await Bun.file(path.join(directory, "function.zip")).arrayBuffer(),
          ),
        },
        Environment: { Variables: { AWS_ENDPOINT_URL: "http://floci:4566" } },
        DurableConfig: { ExecutionTimeout: 120, RetentionPeriodInDays: 1 },
        Publish: true,
      }),
    );
    engine = await run(makeWorkflowEngine(name, "1"));
  }, 120_000);
  afterAll(async () => {
    console.log("DURABLE_OPERATION_COUNTS", JSON.stringify(counts));
    console.log("COMPLETION_HISTORY_COUNTS", JSON.stringify(completionCounts));
    await run(Lambda.deleteFunction({ FunctionName: name }));
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  for (const mode of ["clock", "identity", "child", "retry", "exhaust", "timeout", "heartbeat"]) {
    test(
      mode,
      async () => {
        const started = await start(mode);
        expect(started.executionRef).toContain("/durable-execution/");
        const execution = await result(started.executionRef!);
        expect(execution.Status).toBe("SUCCEEDED");
        const status = await run(started.status);
        if (mode === "exhaust")
          expect(status).toEqual({ _tag: "Failed", error: new Rejected({ reason: "attempt 3" }) });
        else
          expect(status).toEqual({
            _tag: "Completed",
            result:
              mode === "clock"
                ? "awake"
                : mode === "identity"
                  ? "same"
                  : mode === "child"
                    ? `child:${started.payload.id}`
                    : mode === "retry"
                      ? "attempt 3"
                      : "timed out",
          });
        await measure(mode, started.executionRef!);
        const history = [...(await events(started.executionRef!))];
        if (mode === "child") {
          expect(history.some((e) => e.ChainedInvokeStartedDetails !== undefined)).toBe(true);
          expect(history.some((e) => e.Name?.startsWith("child-wait"))).toBe(false);
        }
        if (mode === "retry") {
          const failures = history.flatMap((e) =>
            e.StepFailedDetails ? [e.StepFailedDetails.RetryDetails] : [],
          );
          expect(failures.map((r) => r.CurrentAttempt)).toEqual([1, 2]);
          expect(failures.every((r) => r.NextAttemptDelaySeconds === 1)).toBe(true);
        }
        if (mode === "timeout" || mode === "heartbeat") {
          const callback = history.find((e) => e.CallbackStartedDetails)?.CallbackStartedDetails;
          expect(callback?.Timeout).toBe(mode === "timeout" ? 2 : 30);
          if (mode === "heartbeat") expect(callback?.HeartbeatTimeout).toBe(2);
          expect(history.some((e) => e.CallbackTimedOutDetails !== undefined)).toBe(true);
          const requests: RequestReceipt[] = [];
          const saved = Workflows.makeRun(
            await measuredEngine(requests),
            Probe,
            started.executionId,
            started.executionRef,
          );
          await assertNotWaiting(saved.complete(Approval, Exit.succeed("late")), Approval.name);
          expect(recordCompletion(`${mode}/closed`, requests, true).sends).toBe(0);
        }
      },
      90_000,
    );
  }
  test("concurrent starts return independent receipts and saved references can be read", async () => {
    const runs = await Promise.all([start("clock"), start("clock")]);
    expect(new Set(runs.map((r) => r.executionRef)).size).toBe(2);
    const fresh = await run(makeWorkflowEngine(name, "1"));
    for (const started of runs) {
      const execution = await result(started.executionRef!);
      expect(execution.Status).toBe("SUCCEEDED");
      const saved = Workflows.makeRun(fresh, Probe, started.executionId, started.executionRef);
      expect(await run(saved.status)).toEqual({ _tag: "Completed", result: "awake" });
    }
  }, 90_000);

  test("retry survives a runtime process restart", async () => {
    const started = await start("restart");
    await run(
      Lambda.getDurableExecutionHistory.items({ DurableExecutionArn: started.executionRef! }).pipe(
        Stream.runCollect,
        Effect.repeat({
          schedule: Schedule.spaced("200 millis"),
          until: (events) => [...events].some((e) => e.StepFailedDetails),
          times: 100,
        }),
        Effect.tap((events) =>
          Effect.sync(() => expect([...events].some((e) => e.StepFailedDetails)).toBe(true)),
        ),
      ),
    );
    const containers = execFileSync("docker", ["ps", "-q", "--filter", `name=floci-aws-${name}-`], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    expect(containers.length).toBeGreaterThan(0);
    for (const container of containers)
      execFileSync("docker", ["restart", "--time", "1", container]);
    expect((await result(started.executionRef!)).Status).toBe("SUCCEEDED");
    expect(await run(started.status)).toEqual({ _tag: "Completed", result: "attempt 3" });
    await measure("restart", started.executionRef!);
  }, 90_000);

  for (const mode of ["success", "fail", "failCause"]) {
    test(`direct deferred ${mode}`, async () => {
      const started = await start(mode);
      const token = DurableDeferred.tokenFromExecutionId(Approval, {
        workflow: Probe,
        executionId: started.executionId,
      });
      await awaitCallback(started.executionRef!, Approval.name);
      const requests: RequestReceipt[] = [];
      const freshEngine = await measuredEngine(requests);
      const completion = Workflows.completeDeferred(Approval, {
        token,
        executionRef: started.executionRef,
        exit:
          mode === "success"
            ? Exit.succeed("approved")
            : mode === "fail"
              ? Exit.fail(new Rejected({ reason: "no" }))
              : Exit.failCause(Cause.fail(new Rejected({ reason: "no" }))),
      });
      await run(Effect.provideService(completion, WorkflowEngine.WorkflowEngine, freshEngine));
      const measured = recordCompletion(mode, requests, true);
      expect(measured.history).toBe(1);
      expect(measured.sends).toBe(1);
      expect((await result(started.executionRef!)).Status).toBe("SUCCEEDED");
      expect(await run(started.status)).toEqual(
        mode === "success"
          ? { _tag: "Completed", result: "approved" }
          : { _tag: "Failed", error: new Rejected({ reason: "no" }) },
      );
      const closedRequests: RequestReceipt[] = [];
      const closedRun = Workflows.makeRun(
        await measuredEngine(closedRequests),
        Probe,
        started.executionId,
        started.executionRef,
      );
      await assertNotWaiting(closedRun.complete(Approval, Exit.succeed("again")), Approval.name);
      expect(recordCompletion(`${mode}/closed`, closedRequests, true).sends).toBe(0);
      await measure(mode, started.executionRef!);
      if (mode !== "success")
        expect(
          [...(await events(started.executionRef!))].some((e) => e.CallbackFailedDetails),
        ).toBe(true);
    }, 90_000);
  }
  test("completion without executionRef discovers the ARN once", async () => {
    const started = await start("without-ref");
    await awaitCallback(started.executionRef!, Approval.name);
    const requests: RequestReceipt[] = [];
    const saved = Workflows.makeRun(await measuredEngine(requests), Probe, started.executionId);
    await run(saved.complete(Approval, Exit.succeed("found")));
    expect(recordCompletion("without-ref", requests, false)).toEqual({
      history: 1,
      list: 1,
      sends: 1,
    });
    expect((await result(started.executionRef!)).Status).toBe("SUCCEEDED");
    expect(await run(started.status)).toEqual({ _tag: "Completed", result: "found" });
  }, 90_000);

  test("early completion returns typed NotYetWaiting and plain Effect done defects", async () => {
    const started = await start("early");
    const requests: RequestReceipt[] = [];
    const fresh = await measuredEngine(requests);
    const saved = Workflows.makeRun(fresh, Probe, started.executionId, started.executionRef);
    await assertNotWaiting(saved.complete(Approval, Exit.succeed("too soon")), Approval.name);
    expect(recordCompletion("early", requests, true)).toEqual({ history: 1, list: 0, sends: 0 });
    const token = DurableDeferred.tokenFromExecutionId(Approval, {
      workflow: Probe,
      executionId: started.executionId,
    });
    const plainRequests: RequestReceipt[] = [];
    const plainEngine = await measuredEngine(plainRequests);
    const exit = await run(
      DurableDeferred.done(Approval, { token, exit: Exit.succeed("too soon") }).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, plainEngine),
        Effect.provideService(Workflows.ExecutionReference, started.executionRef),
        Effect.exit,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defect = exit.cause.reasons.find((r) => r._tag === "Die");
      expect(defect?._tag === "Die" && defect.defect).toBeInstanceOf(Workflows.NotYetWaiting);
      if (defect?._tag === "Die" && defect.defect instanceof Error)
        expect(defect.defect.message).toContain("is not waiting on deferred approval");
    }
    expect(recordCompletion("early/plain-done", plainRequests, true)).toEqual({
      history: 1,
      list: 0,
      sends: 0,
    });
    await awaitCallback(started.executionRef!, Approval.name);
    const lateRequests: RequestReceipt[] = [];
    const late = Workflows.makeRun(
      await measuredEngine(lateRequests),
      Probe,
      started.executionId,
      started.executionRef,
    );
    await run(late.complete(Approval, Exit.succeed("after wait")));
    expect(recordCompletion("early/after-wait", lateRequests, true)).toEqual({
      history: 1,
      list: 0,
      sends: 1,
    });
    expect((await result(started.executionRef!)).Status).toBe("SUCCEEDED");
    expect(await run(started.status)).toEqual({ _tag: "Completed", result: "after wait" });
  }, 90_000);

  test("a loop waits on distinct deferred names without re-matching the first", async () => {
    const started = await start("loop");
    for (const [index, deferred] of LoopApprovals.entries()) {
      await awaitCallback(started.executionRef!, deferred.name);
      if (index === 1) {
        const requests: RequestReceipt[] = [];
        const saved = Workflows.makeRun(
          await measuredEngine(requests),
          Probe,
          started.executionId,
          started.executionRef,
        );
        await assertNotWaiting(
          saved.complete(LoopApprovals[0]!, Exit.succeed("stale")),
          LoopApprovals[0]!.name,
        );
        expect(recordCompletion("loop/first-closed", requests, true).sends).toBe(0);
      }
      const requests: RequestReceipt[] = [];
      const saved = Workflows.makeRun(
        await measuredEngine(requests),
        Probe,
        started.executionId,
        started.executionRef,
      );
      await run(saved.signal(deferred, `value${index}`));
      expect(recordCompletion(`loop/${index}`, requests, true).sends).toBe(1);
    }
    expect((await result(started.executionRef!)).Status).toBe("SUCCEEDED");
    expect(await run(started.status)).toEqual({ _tag: "Completed", result: "value0,value1" });
  }, 90_000);

  test("reverse history paging finds an open wait behind later steps", async () => {
    const started = await start("paged");
    await run(
      Lambda.getDurableExecutionHistory.items({ DurableExecutionArn: started.executionRef! }).pipe(
        Stream.runCollect,
        Effect.repeat({
          schedule: Schedule.spaced("200 millis"),
          times: 100,
          until: (events) =>
            [...events].some(
              (e) => e.Name === "filler/31/1" && e.StepSucceededDetails !== undefined,
            ),
        }),
        Effect.tap((events) =>
          Effect.sync(() =>
            expect(
              [...events].some(
                (e) => e.Name === "filler/31/1" && e.StepSucceededDetails !== undefined,
              ),
            ).toBe(true),
          ),
        ),
      ),
    );
    const requests: RequestReceipt[] = [];
    const saved = Workflows.makeRun(
      await measuredEngine(requests),
      Probe,
      started.executionId,
      started.executionRef,
    );
    await run(saved.signal(Approval, "paged"));
    expect(recordCompletion("paged", requests, true).history).toBeGreaterThan(1);
    expect((await result(started.executionRef!)).Status).toBe("SUCCEEDED");
    expect(await run(started.status)).toEqual({ _tag: "Completed", result: "paged" });
  }, 90_000);
});
