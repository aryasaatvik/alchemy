import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@alchemy.run/test";
import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { Effect, Layer, Schedule, Stream } from "effect";
import { services } from "./fixtures/workflow-floci/services.ts";

const endpoint = process.env.WORKFLOW_FLOCI_ENDPOINT;
const legacy = process.env.WORKFLOW_FLOCI_BASELINE_ROOT;
const fixture = "packages/integration-tests/test/AWS/Lambda/fixtures/workflow-cutover";
const current = path.resolve(import.meta.dirname, "../../../../..");

type Build = "legacy" | "candidate";
type Operation = "start" | "success" | "failure" | "early" | "interrupt" | "resume" | "status";
interface Receipt {
  executionId: string;
  executionRef: string;
}
interface Invocation {
  arn: string;
  build: Build;
  version: string;
  requestId: string;
}

const buildFunction = async (root: string, destination: string) => {
  const sdk = "@aws/durable-execution-sdk-js";
  const sdkEntry = Bun.resolveSync(sdk, path.join(root, fixture));
  const sdkDir = path.join(destination, "node_modules", sdk);
  await mkdir(sdkDir, { recursive: true });
  for (const [entry, output, external] of [
    [
      path.join(root, fixture, "runtime.ts"),
      path.join(destination, "index.mjs"),
      [sdk, "@effect/platform-bun/BunHttpServer", "react-devtools-core"],
    ],
    [sdkEntry, path.join(sdkDir, "index.mjs"), []],
  ] as const) {
    const bundle = await Bun.build({
      entrypoints: [entry],
      target: "node",
      external: [...external],
    });
    if (!bundle.success) throw new AggregateError(bundle.logs);
    await writeFile(output, await bundle.outputs[0]!.text());
  }
  await writeFile(
    path.join(sdkDir, "package.json"),
    JSON.stringify({ type: "module", main: "index.mjs" }),
  );
  execFileSync("zip", ["-qr", "function.zip", "index.mjs", "node_modules"], { cwd: destination });
  return new Uint8Array(await Bun.file(path.join(destination, "function.zip")).arrayBuffer());
};

const until = <A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.repeat({ until: predicate, schedule: Schedule.spaced("200 millis"), times: 100 }),
    Effect.tap((value) =>
      predicate(value) ? Effect.void : Effect.die(new Error("Expected Floci state did not settle")),
    ),
  );

it.skipIf(!endpoint || !legacy)(
  "moves live from beta.85 to the rebuilt Lambda and completes suspended work both ways",
  async () => {
    const url = new URL(endpoint!);
    expect(url.origin).toBe(`http://127.0.0.1:${url.port}`);
    const layer = services(url.origin);
    const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)));
    const functionName = `lane1-cutover-${crypto.randomUUID().slice(0, 8)}`;
    const temporary = await mkdtemp(path.join(tmpdir(), "lane1-cutover-"));
    const roots = { legacy: legacy!, candidate: current };
    const client = async (
      build: Build,
      operation: Operation,
      id: string,
      options: { executionRef?: string; suspend?: boolean; qualifier?: string } = {},
    ) => {
      const subprocess = Bun.spawn(
        [
          process.execPath,
          "run",
          path.join(roots[build], fixture, "client.ts"),
          JSON.stringify({ endpoint: url.origin, functionName, operation, id, ...options }),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exit, output, error] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      if (exit !== 0) throw new Error(`${build} ${operation} exited ${exit}: ${error}`);
      return JSON.parse(output);
    };
    const start = async (build: Build, id: string, suspend = false, qualifier?: string) => {
      const result: Receipt = await client(build, "start", id, { suspend, qualifier });
      expect(result.executionRef).toContain("/durable-execution/");
      return result;
    };
    const history = (executionRef: string) =>
      Lambda.getDurableExecutionHistory
        .items({ DurableExecutionArn: executionRef })
        .pipe(Stream.runCollect);
    const pending = (receipt: Receipt, deferred: string) =>
      run(
        until(
          history(receipt.executionRef),
          (events) =>
            events.some(
              (event) => event.EventType === "ContextStarted" && event.Name === deferred,
            ) && events.some((event) => event.EventType === "InvocationCompleted"),
        ),
      );
    const settled = (receipt: Receipt) =>
      run(
        until(
          Lambda.getDurableExecution({ DurableExecutionArn: receipt.executionRef }),
          (value) => value.Status !== "RUNNING",
        ),
      );
    const act = (build: Build, operation: Operation, receipt: Receipt) =>
      client(build, operation, receipt.executionId, { executionRef: receipt.executionRef });
    const invocations = async (receipt: Receipt) => {
      const found = await run(
        until(
          Logs.filterLogEvents.items({ logGroupName: `/aws/lambda/${functionName}` }).pipe(
            Stream.runCollect,
            Effect.catchTag("ResourceNotFoundException", () => Effect.succeed([])),
            Effect.map((events) =>
              events.flatMap((event) => {
                const match = event.message?.match(/CUTOVER_INVOCATION (\{[^\n]*\})/);
                if (!match) return [];
                const invocation: Invocation = JSON.parse(match[1]!);
                return invocation.arn === receipt.executionRef ? [invocation] : [];
              }),
            ),
          ),
          (events) => new Set(events.map((event) => event.requestId)).size >= 2,
        ),
      );
      return found.at(-1)!;
    };
    const env = (build: Build) => ({
      Variables: { AWS_ENDPOINT_URL: "http://floci:4566", CUTOVER_BUILD: build },
    });

    let created = false;
    try {
      const [oldCode, newCode] = await Promise.all([
        buildFunction(roots.legacy, path.join(temporary, "legacy")),
        buildFunction(roots.candidate, path.join(temporary, "candidate")),
      ]);
      await run(
        Lambda.createFunction({
          FunctionName: functionName,
          Runtime: "nodejs24.x",
          Handler: "index.handler",
          Role: "arn:aws:iam::000000000000:role/cutover-fixture",
          Timeout: 30,
          Code: { ZipFile: oldCode },
          Environment: env("legacy"),
          DurableConfig: { ExecutionTimeout: 120, RetentionPeriodInDays: 1 },
          Publish: true,
        }),
      );
      created = true;
      await run(
        Lambda.createAlias({ FunctionName: functionName, Name: "live", FunctionVersion: "1" }),
      );

      const pinProbe = await start("legacy", "pin-probe");
      const kinds = ["success", "failure", "early", "interrupt", "resume", "status"] as const;
      let oldRuns = await Promise.all(
        kinds.map(async (kind) => ({
          kind,
          receipt: await start("legacy", `legacy-${kind}`, kind === "resume"),
        })),
      );
      await Promise.all([
        pending(pinProbe, "approval"),
        ...oldRuns.map(({ kind, receipt }) =>
          pending(receipt, kind === "resume" ? "hold/1/suspended-0" : "approval"),
        ),
      ]);

      await run(Lambda.updateFunctionCode({ FunctionName: functionName, ZipFile: newCode }));
      await run(
        Lambda.updateFunctionConfiguration({
          FunctionName: functionName,
          Environment: env("candidate"),
        }),
      );
      const published = await run(Lambda.publishVersion({ FunctionName: functionName }));
      expect(published.Version).toBe("2");
      await run(
        Lambda.updateAlias({ FunctionName: functionName, Name: "live", FunctionVersion: "2" }),
      );
      expect(
        (await run(Lambda.getAlias({ FunctionName: functionName, Name: "live" }))).FunctionVersion,
      ).toBe("2");

      // The legacy sender isolates the emulator's version behavior from the port.
      await act("legacy", "success", pinProbe);
      const pinExecution = await settled(pinProbe);
      const pinStatus = await act("legacy", "status", pinProbe);
      const pinsVersions = pinStatus.result === "approved:legacy:1";
      expect(pinExecution.Status).toBe("SUCCEEDED");
      console.log(
        "CUTOVER_PIN",
        JSON.stringify({ pinsVersions, providerVersion: pinExecution.Version, status: pinStatus }),
      );
      if (!pinsVersions) {
        // Keep the wire proof valid if the emulator re-routes alias-started
        // executions. Explicitly target immutable v1 for the legacy waiters.
        oldRuns = await Promise.all(
          kinds.map(async (kind) => ({
            kind,
            receipt: await start("legacy", `numbered-legacy-${kind}`, kind === "resume", "1"),
          })),
        );
      }

      for (const [waiter, sender, matrix, version] of [
        ["legacy", "candidate", oldRuns, "1"],
        [
          "candidate",
          "legacy",
          await Promise.all(
            kinds.map(async (kind) => ({
              kind,
              receipt: await start("candidate", `candidate-${kind}`, kind === "resume"),
            })),
          ),
          "2",
        ],
      ] as const) {
        for (const { kind, receipt } of matrix) {
          const waitName = kind === "resume" ? "hold/1/suspended-0" : "approval";
          await pending(receipt, waitName);
          if (kind === "early") {
            expect(await act(sender, "early", receipt)).toMatchObject({
              _tag: "NotYetWaiting",
              deferredName: "future",
            });
          }
          if (kind === "status") {
            expect(await act(sender, "status", receipt)).toEqual({ _tag: "Running" });
          }
          if (kind === "resume") {
            await act(sender, "resume", receipt);
            await pending(receipt, "hold/1/suspended-1");
            const replay = await invocations(receipt);
            expect(replay).toMatchObject({ build: waiter, version });
            console.log("CUTOVER_COMPLETION", JSON.stringify({ waiter, sender, kind, ...replay }));
          }
          const operation =
            kind === "failure"
              ? "failure"
              : kind === "interrupt" || kind === "resume"
                ? "interrupt"
                : "success";
          await act(sender, operation, receipt);
          const execution = await settled(receipt);
          expect(execution.Version).toBe(version);
          const status = await act(sender, "status", receipt);
          expect(status).toEqual(
            operation === "interrupt"
              ? { _tag: "Interrupted" }
              : operation === "failure"
                ? {
                    _tag: "Failed",
                    error: { _tag: "Rejected", reason: `rejected:${waiter}:${version}` },
                  }
                : { _tag: "Completed", result: `approved:${waiter}:${version}` },
          );
          const replay = await invocations(receipt);
          expect(replay).toMatchObject({ build: waiter, version });
          console.log(
            "CUTOVER_COMPLETION",
            JSON.stringify({ waiter, sender, kind, operation, status, ...replay }),
          );
        }
      }
    } finally {
      try {
        if (created) await run(Lambda.deleteFunction({ FunctionName: functionName }));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  },
  { timeout: 180_000, tags: ["local", "provider:aws:lambda"] },
);
