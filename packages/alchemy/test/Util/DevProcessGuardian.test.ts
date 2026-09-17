import { startDevProcessGuardian } from "@/Util/DevProcessGuardian.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

const treeFixture = NodePath.resolve(
  import.meta.dirname,
  "../Command/fixture/ignore-term-tree.cjs",
);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    if (process.platform !== "win32") {
      const state = NodeChildProcess.execFileSync(
        "ps",
        ["-o", "stat=", "-p", String(pid)],
        { encoding: "utf8" },
      ).trim();
      // A force-killed orphan can remain as a zombie until its new parent
      // reaps it. It no longer owns resources or runs code, so treat it as
      // dead for the process-tree contract under test.
      if (state.startsWith("Z")) return false;
    }
    return true;
  } catch {
    return false;
  }
};

const waitForDeath = (pid: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5_000;
        const poll = () => {
          if (!isAlive(pid)) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error(`pid ${pid} still alive`));
            return;
          }
          setTimeout(poll, 50);
        };
        poll();
      }),
  );

const awaitExit = (child: NodeChildProcess.ChildProcess) =>
  Effect.callback<void>((resume) => {
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      child.removeListener("exit", complete);
      resume(Effect.void);
    };
    child.once("exit", complete);
    // Register the listener before checking the state: a SIGKILL can deliver
    // the exit event between those operations in a fast process group.
    if (child.exitCode !== null || child.signalCode !== null) complete();
  });

const waitForTreeFile = (path: string) =>
  Effect.promise(
    () =>
      new Promise<{ pid: number; descendantPid: number }>((resolve, reject) => {
        const deadline = Date.now() + 5_000;
        const poll = () => {
          try {
            if (NodeFs.existsSync(path)) {
              const tree = JSON.parse(NodeFs.readFileSync(path, "utf8")) as {
                pid: number;
                descendantPid: number;
              };
              resolve(tree);
              return;
            }
          } catch {
            // The fixture may be between its write and rename operations.
          }
          if (Date.now() >= deadline) {
            reject(new Error("tree not ready"));
            return;
          }
          setTimeout(poll, 50);
        };
        poll();
      }),
  );

describe("DevProcessGuardian", () => {
  it.effect.skipIf(process.platform === "win32")(
    "exits when its supervised target exits",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 60000)"],
            { detached: true, stdio: "ignore" },
          );
          return { child, guardian: startDevProcessGuardian(child.pid!) };
        }),
        ({ child, guardian }) =>
          Effect.gen(function* () {
            expect(isAlive(guardian.pid)).toBe(true);
            process.kill(-child.pid!, "SIGTERM");
            yield* awaitExit(child);
            yield* Effect.promise(() => guardian.exited);
            expect(isAlive(guardian.pid)).toBe(false);
          }),
        ({ child, guardian }) =>
          Effect.sync(() => {
            guardian.stop();
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {}
          }),
      ),
    { timeout: 10_000 },
  );

  it.effect.skipIf(process.platform === "win32")(
    "reaps remembered descendants when a bun run root is force-killed",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const tmp = NodeFs.mkdtempSync(
            NodePath.join(NodeOs.tmpdir(), "alchemy-guardian-"),
          );
          const pidFile = NodePath.join(tmp, "tree.json");
          const child = NodeChildProcess.spawn(
            process.execPath,
            ["run", treeFixture],
            {
              detached: true,
              stdio: "ignore",
              env: { ...process.env, PID_FILE: pidFile, MARKER: "guardian" },
            },
          );
          return {
            child,
            pidFile,
            guardian: startDevProcessGuardian(child.pid!),
          };
        }),
        ({ child, pidFile, guardian }) =>
          Effect.gen(function* () {
            const tree = yield* waitForTreeFile(pidFile);
            expect(tree.pid).toBe(child.pid);
            // `alchemy-test` uses a controllable Effect test clock; this delay
            // intentionally gives the detached guardian a real scheduling
            // window to snapshot the Bun-spawned descendant.
            yield* Effect.promise(
              () => new Promise((resolve) => setTimeout(resolve, 250)),
            );

            // The root cannot run cleanup after SIGKILL. The guardian must
            // remember its Bun-spawned descendant and terminate the shared
            // process group rather than abandoning that orphan.
            process.kill(child.pid!, "SIGKILL");
            yield* awaitExit(child);
            yield* Effect.promise(() => guardian.exited);

            yield* waitForDeath(tree.descendantPid);
            expect(isAlive(guardian.pid)).toBe(false);
          }),
        ({ child, guardian }) =>
          Effect.sync(() => {
            guardian.stop();
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {}
          }),
      ),
    { timeout: 15_000 },
  );
});
