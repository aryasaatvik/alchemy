import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";

const GRACE_PERIOD_MILLIS = 1_000;

const processIdentity = (pid: number): string => {
  if (process.platform === "linux" && NodeFs.existsSync(`/proc/${pid}/stat`)) {
    const stat = NodeFs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  }
  if (process.platform === "win32") {
    return NodeChildProcess.execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$p=Get-Process -Id $args[0] -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks",
        `${pid}`,
      ],
      { encoding: "utf8" },
    ).trim();
  }
  return NodeChildProcess.execFileSync(
    "ps",
    ["-o", "lstart=", "-o", "command=", "-p", `${pid}`],
    { encoding: "utf8" },
  ).trim();
};

// This deliberately has no imports: it is run by whichever Node-compatible
// runtime owns the sidecar (Bun or Node), after that owner may have died.
const guardianProgram = String.raw`
const pid = Number(process.argv[1]);
const ownerPid = Number(process.argv[2]);
const expectedIdentity = Buffer.from(process.argv[3], "base64").toString("utf8");
let stopped = false;
let ended = false;
const identity = () => {
  try {
    if (process.platform === "linux" && require("node:fs").existsSync("/proc/" + pid + "/stat")) {
      const stat = require("node:fs").readFileSync("/proc/" + pid + "/stat", "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || "";
    }
    if (process.platform === "win32") {
      return require("node:child_process").execFileSync("powershell.exe", ["-NoProfile", "-Command", "$p=Get-Process -Id $args[0] -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks", String(pid)], { encoding: "utf8" }).trim();
    }
    return require("node:child_process").execFileSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch { return ""; }
};
const ownsTarget = () => identity() === expectedIdentity;
const killTree = (signal) => {
  if (!ownsTarget()) return false;
  try {
    if (process.platform === "win32") {
      require("node:child_process").execFileSync("taskkill", ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore" });
    } else {
      process.kill(-pid, signal);
    }
    return true;
  } catch { return false; }
};
const finish = () => {
  if (ended || stopped) return;
  ended = true;
  if (!killTree("SIGTERM")) return process.exit(0);
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
// Some detached Bun children keep the stdin descriptor open after their
// owner is hard-killed. The PID probe is the independent owner-death signal;
// stdin still carries the explicit normal-stop marker below.
setInterval(() => {
  if (stopped || ended) return;
  if (!ownsTarget()) return process.exit(0);
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
  /** Guardian PID, exposed for lifecycle verification. */
  readonly pid: number;
  /** Resolves after the guardian process has exited and been reaped. */
  readonly exited: Promise<void>;
  /** Marks normal scoped cleanup complete and prevents emergency escalation. */
  readonly stop: () => void;
}

/**
 * Keeps a detached `Command.Dev` process group from outliving its sidecar.
 *
 * Synchronous exit handlers cannot await a graceful shutdown. This sibling
 * watches its owner's stdin: EOF without the normal-stop marker means the
 * owner disappeared, and the guardian performs SIGTERM -> grace -> SIGKILL
 * itself. Windows uses `taskkill /T` and may terminate console children
 * forcefully because it has no portable SIGTERM process-tree contract.
 */
export const startDevProcessGuardian = (pid: number): DevProcessGuardian => {
  const identity = processIdentity(pid);
  if (identity.length === 0) {
    throw new Error(`Cannot supervise process ${pid}: identity is unavailable`);
  }
  const guardian = NodeChildProcess.spawn(
    process.execPath,
    [
      "-e",
      guardianProgram,
      `${pid}`,
      `${process.pid}`,
      Buffer.from(identity).toString("base64"),
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  guardian.unref();
  const exited = new Promise<void>((resolve) => guardian.once("exit", resolve));

  return {
    pid: guardian.pid!,
    exited,
    stop: () => {
      try {
        guardian.stdin?.end("stop");
      } catch {}
    },
  };
};
