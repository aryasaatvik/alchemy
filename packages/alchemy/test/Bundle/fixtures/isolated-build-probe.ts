import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

// Observe real compiler lifetimes, including cancellation, without replacing
// the process implementation or accepting an artifact from a fake compiler.
const active = new Set<number>();
const pids: number[] = [];
const exits: Promise<void>[] = [];
let peak = 0;
let spawned: (() => void) | undefined;
const fork = childProcess.fork;
childProcess.fork = (...args: Parameters<typeof fork>) => {
  const child = fork(...args);
  assert(child.pid !== undefined);
  const pid = child.pid;
  pids.push(pid);
  active.add(pid);
  peak = Math.max(peak, active.size);
  exits.push(
    new Promise((resolve) =>
      child.once("close", () => {
        active.delete(pid);
        resolve();
      }),
    ),
  );
  spawned?.();
  return child;
};
syncBuiltinESMExports();

let nativeLoads = 0;
const dlopen = process.dlopen;
process.dlopen = (...args: Parameters<typeof dlopen>) => {
  if (String(args[1]).includes("rolldown")) nativeLoads++;
  return dlopen(...args);
};

const Bundle = await import("../../../src/Bundle/Bundle.ts");
const root = await mkdtemp(join(tmpdir(), "alchemy-isolated-bundle-"));
const entry = join(root, "entry.ts");
try {
  await writeFile(entry, 'import text from "./message.txt"; export default text;');
  await writeFile(join(root, "message.txt"), "IMMUTABLE_ARTIFACT");
  const build = Effect.gen(function* () {
    const virtualEntry = yield* Bundle.virtualEntryPlugin;
    return yield* Bundle.buildIsolated(
      {
        input: entry,
        cwd: root,
        external: [/^optional-package(?:\/|$)/],
        plugins: [
          undefined,
          [virtualEntry((main) => `export { default } from ${JSON.stringify(main)};`)],
        ],
      },
      { format: "esm", sourcemap: true },
    );
  }).pipe(Effect.provide(NodeServices.layer));
  const outputs = await Effect.runPromise(Effect.all([build, build, build], { concurrency: 3 }));
  assert.equal(pids.length, 3);
  assert.equal(peak, 1);
  assert.equal(active.size, 0);
  assert.equal(nativeLoads, 0);
  for (const output of outputs) {
    assert.match(String(output.files[0].content), /IMMUTABLE_ARTIFACT/);
    assert(output.files.some((file) => file.path.endsWith(".map")));
    assert.equal(output.hash, outputs[0].hash);
  }

  const failure = await Effect.runPromise(
    Effect.result(Bundle.buildIsolated({ input: join(root, "missing.ts") })),
  );
  assert.equal(failure._tag, "Failure");
  assert.equal(active.size, 0);
  const callbacks = await Effect.runPromise(
    Effect.result(Bundle.buildIsolated({ input: entry, external: () => false })),
  );
  assert.equal(callbacks._tag, "Failure");
  if (callbacks._tag === "Failure")
    assert.match(callbacks.failure.message, /callbacks are unsupported/);
  const plugins = await Effect.runPromise(
    Effect.result(
      Bundle.buildIsolated({ input: entry, plugins: [{ name: "custom", load: () => "" }] }),
    ),
  );
  assert.equal(plugins._tag, "Failure");
  if (plugins._tag === "Failure")
    assert.match(plugins.failure.message, /executable Rolldown plugin "custom"/);
  assert.equal(pids.length, 4);

  const started = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  const fiber = Effect.runFork(build);
  await started;
  await Effect.runPromise(Fiber.interrupt(fiber));
  await Promise.all(exits);
  assert.equal(active.size, 0);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  console.log(`RESULT ${JSON.stringify({ pids, peak, nativeLoads, hash: outputs[0].hash })}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
