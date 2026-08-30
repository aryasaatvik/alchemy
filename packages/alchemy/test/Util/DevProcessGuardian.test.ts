import { startDevProcessGuardian } from "@/Util/DevProcessGuardian.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const awaitExit = (child: NodeChildProcess.ChildProcess) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }
    child.once("exit", () => resume(Effect.void));
  });

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
});
