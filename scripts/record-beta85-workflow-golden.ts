import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

const backup = "994a83ff04fa1a9b004403775f7e622d4d2e1843";
const floci =
  "ghcr.io/aryasaatvik/floci@sha256:2217a421f941032871645fd5fcebfc68abe83ef9a24c1ea224df12385b5879d9";
const root = resolve(import.meta.dir, "..");
const assets = resolve(import.meta.dir, "fixtures/beta85-workflow-golden");
const suite = "packages/integration-tests/test/AWS/Lambda";
const fixture = `${suite}/fixtures/workflow-floci/beta85-golden.ts`;
const archives = resolve(process.env.BETA85_PACK_DIR ?? resolve(root, "artifacts"));
const mode = Bun.argv[2] ?? "--check";
if (mode !== "--check" && mode !== "--write") throw new Error("Use --check or --write");

const cwd = await mkdtemp(
  resolve(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "alchemy-beta85-golden-"),
);
const bun = process.execPath;
const run = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: Uint8Array;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {},
) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });

type Receipt = {
  commit: string;
  packages: Array<{ name: string; tarball: string; sha256: string }>;
};

const historyModes = ["clock", "success", "fail", "suspension"] as const;

const stableHistory = (history: unknown) => {
  const ids = new Map<string, number>();
  return JSON.parse(
    JSON.stringify(history, (key, value) => {
      if (["EventId", "EventTimestamp", "ScheduledEndTimestamp"].includes(key)) return undefined;
      if (key === "CallbackId" && typeof value === "string") return "<callback-id>";
      if ((key === "Id" || key === "ParentId") && typeof value === "string") {
        if (!ids.has(value)) ids.set(value, ids.size + 1);
        return ids.get(value);
      }
      return value;
    }),
  );
};

let network: string | undefined;
let container: string | undefined;
try {
  const receipt: Receipt = await Bun.file(
    resolve(archives, "integration-994a83ff04fa.json"),
  ).json();
  if (receipt.commit !== backup) throw new Error("Expected the beta.85 integration pack receipt");
  const dependencies = Object.fromEntries(
    await Promise.all(
      receipt.packages.map(async (pkg) => {
        const archive = resolve(archives, basename(pkg.tarball));
        const digest = createHash("sha256")
          .update(await Bun.file(archive).bytes())
          .digest("hex");
        if (digest !== pkg.sha256)
          throw new Error(`Unexpected beta.85 archive digest for ${pkg.name}`);
        return [pkg.name, `file:${archive}`] as const;
      }),
    ),
  );
  const archive = execFileSync(
    "git",
    [
      "archive",
      backup,
      `${suite}/WorkflowFunction.floci.test.ts`,
      `${suite}/fixtures/workflow-floci`,
    ],
    { cwd: root },
  );
  run("tar", ["-xf", "-"], { input: archive });
  run("git", ["apply", resolve(assets, "instrument-backup.patch")]);
  await Bun.write(
    resolve(cwd, "package.json"),
    JSON.stringify({
      name: "alchemy-beta85-golden-recorder",
      private: true,
      type: "module",
      dependencies: { ...dependencies, "@aws/durable-execution-sdk-js": "2.6.0", effect: "4.1.4" },
      overrides: { ...dependencies, effect: "4.1.4" },
    }),
  );
  run(bun, ["install", "--ignore-scripts"]);
  await Bun.write(
    resolve(cwd, "record-encoding.ts"),
    Bun.file(resolve(assets, "record-encoding.ts.txt")),
  );
  const [start, encoding] = run(bun, ["record-encoding.ts"])
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const label = `lane1-golden-${crypto.randomUUID().slice(0, 8)}`;
  network = run("docker", ["network", "create", label]).trim();
  container = run("docker", [
    "run",
    "-d",
    "--rm",
    "--pull",
    "never",
    "--name",
    label,
    "--network",
    network,
    "--network-alias",
    "floci",
    "-p",
    "127.0.0.1::4566",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-u",
    "root",
    "-e",
    "FLOCI_AUTH_VALIDATE_SIGNATURES=false",
    "-e",
    "FLOCI_DEFAULT_REGION=us-east-1",
    "-e",
    "FLOCI_STORAGE_MODE=memory",
    "-e",
    `FLOCI_SERVICES_LAMBDA_DOCKER_NETWORK=${label}`,
    "-e",
    `FLOCI_SERVICES_LAMBDA_CONTAINER_NAME_PREFIX=${label}`,
    floci,
  ]).trim();
  const endpoint = `http://${run("docker", ["port", container, "4566/tcp"]).trim()}`;
  run("curl", [
    "-fsS",
    "--retry",
    "8",
    "--retry-all-errors",
    "--retry-delay",
    "1",
    "--max-time",
    "10",
    `${endpoint}/_floci/health`,
  ]);
  const output = run(
    bun,
    [
      "test",
      `${suite}/WorkflowFunction.floci.test.ts`,
      "--test-name-pattern",
      "direct deferred|early completion|clock|record a suspended",
    ],
    { env: { ...process.env, WORKFLOW_FLOCI_ENDPOINT: endpoint } },
  );
  const histories = new Map<string, unknown[]>();
  const callbacks = new Map<string, string>();
  let notYetWaiting: unknown;
  for (const line of output.split("\n")) {
    if (line.startsWith("GOLD_HISTORY ")) {
      const { mode, history } = JSON.parse(line.slice("GOLD_HISTORY ".length));
      histories.set(
        mode,
        history.filter((event: { EventType: string }) =>
          /^(Wait|Step|Context|Callback)/.test(event.EventType),
        ),
      );
    } else if (line.startsWith("GOLD_CALLBACK ")) {
      const match = /^GOLD_CALLBACK (\w+) (.*)$/.exec(line)!;
      callbacks.set(match[1]!, match[2]!);
    } else if (line.startsWith("GOLD_NOT_YET_WAITING ")) {
      notYetWaiting = JSON.parse(line.slice("GOLD_NOT_YET_WAITING ".length));
    }
  }
  if (
    historyModes.some((key) => !histories.has(key)) ||
    !callbacks.has("success") ||
    !callbacks.has("fail") ||
    !notYetWaiting
  ) {
    throw new Error("The beta.85 run did not record all golden observations");
  }

  const recorded = {
    start,
    ...encoding,
    callback: { success: callbacks.get("success"), fail: callbacks.get("fail") },
    notYetWaiting,
    histories: Object.fromEntries(historyModes.map((key) => [key, histories.get(key)])),
  };
  if (mode === "--write") {
    const path = resolve(root, fixture);
    const existing = await Bun.file(path).text();
    await Bun.write(
      path,
      existing.slice(0, existing.indexOf("export const golden")) +
        `export const golden = ${JSON.stringify(recorded, null, 2)} as const;\n`,
    );
    run(resolve(root, "node_modules/.bin/oxfmt"), ["--disable-nested-config", path], { cwd: root });
  } else {
    const { golden } = await import(resolve(root, fixture));
    const { histories: expectedHistories, ...expectedWire } = golden;
    const { histories: recordedHistories, ...recordedWire } = recorded;
    if (JSON.stringify(expectedWire) !== JSON.stringify(recordedWire))
      throw new Error("The beta.85 serialization changed");
    for (const key of historyModes) {
      if (
        JSON.stringify(stableHistory(expectedHistories[key])) !==
        JSON.stringify(stableHistory(recordedHistories[key]))
      )
        throw new Error(`The recorded beta.85 ${key} history changed`);
    }
  }
  console.log(`Verified beta.85 golden observations (${mode})`);
} finally {
  try {
    if (container) run("docker", ["stop", container]);
  } finally {
    try {
      if (network) run("docker", ["network", "rm", network]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
