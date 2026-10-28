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
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { DurableDeferred, WorkflowEngine } from "effect/workflow";
import { services } from "./fixtures/workflow-floci/services.ts";
import { Approval, Probe, Rejected } from "./fixtures/workflow-floci/workflows.ts";

const endpoint = process.env.WORKFLOW_FLOCI_ENDPOINT;
const name = `alchemy-workflow-pr3-${crypto.randomUUID().slice(0, 8)}`;
const layer = services(endpoint ?? "http://127.0.0.1:0");
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);
const text = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;
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

describe.skipIf(!endpoint)("WorkflowFunction on isolated Floci", () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "alchemy-workflow-pr3-"));
    await run(S3.createBucket({ Bucket: "pr3-workflow-callbacks" }));
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
      // Prove registration before completion; missing-token semantics are intentionally unspecified.
      await run(
        Effect.promise(() => fetch(`${endpoint}/pr3-workflow-callbacks/${token}`)).pipe(
          Effect.repeat({ schedule: Schedule.spaced("500 millis"), until: (r) => r.ok, times: 50 }),
          Effect.tap((r) => Effect.sync(() => expect(r.ok).toBe(true))),
        ),
      );
      // A fresh caller engine has no process-local registration state.
      const freshEngine = await run(makeWorkflowEngine(name, "1"));
      const completion =
        mode === "success"
          ? DurableDeferred.succeed(Approval, { token, value: "approved" })
          : mode === "fail"
            ? DurableDeferred.fail(Approval, { token, error: new Rejected({ reason: "no" }) })
            : DurableDeferred.failCause(Approval, {
                token,
                cause: Cause.fail(new Rejected({ reason: "no" })),
              });
      await run(Effect.provideService(completion, WorkflowEngine.WorkflowEngine, freshEngine));
      expect((await result(started.executionRef!)).Status).toBe("SUCCEEDED");
      expect(await run(started.status)).toEqual(
        mode === "success"
          ? { _tag: "Completed", result: "approved" }
          : { _tag: "Failed", error: new Rejected({ reason: "no" }) },
      );
      await measure(mode, started.executionRef!);
      if (mode !== "success")
        expect(
          [...(await events(started.executionRef!))].some((e) => e.CallbackFailedDetails),
        ).toBe(true);
    }, 90_000);
  }
});
