import * as NodeChildProcess from "node:child_process";

const GRACE_PERIOD_MILLIS = 1_000;

const guardianProgram = String.raw`
const pid = Number(process.argv[1]);
const ownerPid = Number(process.argv[2]);
let stopped = false;
let ended = false;
const killTree = (signal) => {
  try {
    if (process.platform === "win32") {
      require("node:child_process").execFileSync("taskkill", ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore" });
    } else {
      process.kill(-pid, signal);
    }
  } catch {}
};
const finish = () => {
  if (ended || stopped) return;
  ended = true;
  killTree("SIGTERM");
  setTimeout(() => {
    killTree("SIGKILL");
    process.exit(0);
  }, ${GRACE_PERIOD_MILLIS});
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { if (chunk.includes("stop")) stopped = true; });
process.stdin.on("end", finish);
process.stdin.on("close", finish);
process.stdin.on("error", finish);
process.stdin.resume();
setInterval(() => {
  if (stopped || ended) return;
  if (process.ppid !== ownerPid) {
    finish();
    return;
  }
  try {
    process.kill(ownerPid, 0);
  } catch {
    finish();
  }
}, 100).unref();
`;

export interface DevProcessGuardian {
  readonly stop: () => void;
}

/**
 * Keeps a detached `Command.Dev` process group from outliving its sidecar.
 * `exit-hook` exits synchronously, so this sibling owns the bounded
 * SIGTERM -> SIGKILL shutdown after abrupt sidecar loss.
 */
export const startDevProcessGuardian = (pid: number): DevProcessGuardian => {
  const guardian = NodeChildProcess.spawn(
    process.execPath,
    ["-e", guardianProgram, `${pid}`, `${process.pid}`],
    { detached: true, stdio: ["pipe", "ignore", "ignore"] },
  );
  guardian.unref();

  return {
    stop: () => {
      try {
        guardian.stdin?.end("stop");
      } catch {}
    },
  };
};
