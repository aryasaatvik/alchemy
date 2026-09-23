import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../bin/cli.js", import.meta.url));
const STACK = fileURLToPath(
  new URL("./fixtures/data-dir-stack.ts", import.meta.url),
);

/**
 * Run the CLI from an empty project directory, with `ALCHEMY_HOME` pointed at
 * a throwaway directory, and return its exit code and stderr.
 */
const run = (
  project: string,
  home: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make("bun", [CLI, ...args], {
      cwd: project,
      env: { ALCHEMY_HOME: home, ...env },
      extendEnv: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: "1 second",
    });
    const [stderr, exitCode] = yield* Effect.all(
      [handle.stderr.pipe(Stream.decodeText, Stream.mkString), handle.exitCode],
      { concurrency: 2 },
    );
    return { stderr, exitCode };
  }).pipe(Effect.scoped);

describe("CLI --data-dir", { tags: ["unit", "local"] }, () => {
  it.live(
    "deploy, dev, and destroy keep state and logs under the data directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-data-dir-home-",
        });
        const project = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-data-dir-project-",
        });
        const dataDir = path.join(project, "runs", "one");
        const output = (stage: string) =>
          path.join(
            dataDir,
            "state",
            "CliDataDir",
            stage,
            "__stack_output__.json",
          );

        const deployed = yield* run(project, home, [
          "deploy",
          STACK,
          "--yes",
          "--stage",
          "datadir",
          "--data-dir",
          dataDir,
        ]);
        expect(deployed.stderr).toBe("");
        expect(deployed.exitCode).toBe(0);
        expect(yield* fs.exists(output("datadir"))).toBe(true);
        expect(yield* fs.exists(path.join(dataDir, "log"))).toBe(true);

        // Samva's supervisor shape: `dev --env-file … --stage … --data-dir …`.
        const envFile = path.join(project, ".env.run");
        yield* fs.writeFileString(envFile, "");
        const dev = yield* run(
          project,
          home,
          [
            "dev",
            STACK,
            "--env-file",
            envFile,
            "--stage",
            "datadir-dev",
            "--data-dir",
            dataDir,
          ],
          { ALCHEMY_DEV_ONCE: "1" },
        );
        expect(dev.exitCode).toBe(0);
        expect(yield* fs.exists(output("datadir-dev"))).toBe(true);

        const destroyed = yield* run(project, home, [
          "destroy",
          STACK,
          "--yes",
          "--env-file",
          envFile,
          "--stage",
          "datadir",
          "--data-dir",
          dataDir,
        ]);
        expect(destroyed.exitCode).toBe(0);

        // No run data fell back to the invocation directory's `.alchemy`
        // (only the CLI-wide version-check cache lives there).
        const fallback = path.join(project, ".alchemy");
        expect(yield* fs.exists(path.join(fallback, "state"))).toBe(false);
        expect(yield* fs.exists(path.join(fallback, "log"))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    { timeout: 120_000 },
  );
});
