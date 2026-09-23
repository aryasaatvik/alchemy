import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const GRACE_PERIOD_MILLIS = 1_000;
const POLL_INTERVAL_MILLIS = 100;

/** Appears in every guardian's command line, for process-table lookups. */
export const GUARDIAN_MARKER = "alchemy-dev-guardian";

// Runs under whichever Node-compatible runtime owns the dev process (Bun or
// Node), after that owner may have died, so it has no imports beyond
// built-ins. POSIX only.
const guardianProgram = String.raw`
// ${GUARDIAN_MARKER}
const { execFileSync } = require("node:child_process");
const pgid = Number(process.argv[1]);
const ownerPid = Number(process.argv[2]);
const alive = (target) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const startTime = (pid) => {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
};
const leader = startTime(pgid);
if (leader === "") process.exit(0);
// The group is still the one we guard while its leader keeps its start time,
// or while the leader is gone but the group lives on: a pgid is never reused
// while its group has members.
const owned = () => {
  const current = startTime(pgid);
  return current === "" ? alive(-pgid) : current === leader;
};
const signal = (name) => {
  if (!owned()) return false;
  try {
    process.kill(-pgid, name);
    return true;
  } catch {
    return false;
  }
};
const timer = setInterval(() => {
  if (!alive(-pgid)) process.exit(0);
  if (process.ppid === ownerPid && alive(ownerPid)) return;
  clearInterval(timer);
  if (!signal("SIGTERM")) process.exit(0);
  setTimeout(() => {
    signal("SIGKILL");
    process.exit(0);
  }, ${GRACE_PERIOD_MILLIS});
}, ${POLL_INTERVAL_MILLIS});
`;

/**
 * Reap a detached dev process group if its owner dies without running
 * finalizers (SIGKILL, crash, OOM).
 *
 * The owner's scope normally terminates the group (`CommandExecutor.spawn`'s
 * release) and then this guardian with it. A hard-killed owner runs neither,
 * so the guardian, detached into its own group, polls for the owner and
 * performs SIGTERM → grace → SIGKILL on the dev group itself. It exits on its
 * own once the dev group is gone. Close its scope only after the dev process
 * has been terminated. Windows has no process-group signals; the guardian is
 * skipped there.
 */
export const guardDevProcessGroup = Effect.fn(function* (pgid: number) {
  if (process.platform === "win32") return undefined;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      ["-e", guardianProgram, `${pgid}`, `${process.pid}`],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        killSignal: "SIGKILL",
      },
    ),
  );
});
