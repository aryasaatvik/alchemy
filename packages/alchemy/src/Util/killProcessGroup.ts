import { exitHook } from "@alchemy.run/node-utils/exit-hook";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";

/** Best-effort termination of a child process's full process group. */
export const killProcessGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    if (process.platform === "win32") {
      NodeChildProcess.execSync(`taskkill /pid ${pid} /T /F`);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Ignore errors during best-effort process cleanup.
  }
};

/**
 * Register a last-resort group kill for abrupt process exit and unregister it
 * when the owning Effect scope closes normally.
 */
export const registerExitKill = (pid: number) =>
  Effect.acquireRelease(
    Effect.sync(() => exitHook(() => killProcessGroup(pid, "SIGKILL"))),
    (unregister) => Effect.sync(unregister),
  );
