import {
  awaitEvaluationExit,
  DevEvaluationExited,
} from "@/Cli/commands/dev.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import {
  type ChildProcessHandle,
  ExitCode,
} from "effect/unstable/process/ChildProcessSpawner";
import * as pathe from "pathe";

const repositoryRoot = pathe.resolve(import.meta.dirname, "../../../..");
const fixtureParent = pathe.resolve(import.meta.dirname, "fixtures");

const waitForOutput = (output: Ref.Ref<string>, expected: string) =>
  Ref.get(output).pipe(
    Effect.filterOrFail(
      (text) => text.includes(expected),
      () =>
        new Error(`Dev output did not include ${JSON.stringify(expected)}.`),
    ),
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      times: 300,
    }),
  );

const waitForStopped = (
  child: ChildProcessHandle,
): Effect.Effect<void, Error> =>
  child.isRunning.pipe(
    Effect.orElseSucceed(() => false),
    Effect.filterOrFail(
      (running) => !running,
      () => new Error("alchemy dev is still running"),
    ),
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      times: 100,
    }),
    Effect.asVoid,
  );

describe("alchemy dev evaluation lifetime", () => {
  it.effect("treats a watched evaluation exit with code 0 as failure", () =>
    Effect.gen(function* () {
      const error = yield* awaitEvaluationExit(
        Effect.succeed(ExitCode(0)),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(DevEvaluationExited);
      expect(error.exitCode).toBe(0);
    }),
  );

  it.live(
    "stays alive across imported-file re-evaluation and stops on SIGTERM",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* fs.makeTempDirectoryScoped({
          directory: fixtureParent,
          prefix: "dev-lifetime-",
        });
        const dataDir = pathe.join(fixture, "data");
        const stackFile = pathe.join(fixture, "alchemy.run.ts");
        const valueFile = pathe.join(fixture, "value.ts");

        yield* fs.writeFileString(
          stackFile,
          [
            'import * as Alchemy from "alchemy";',
            'import * as Effect from "effect/Effect";',
            'import * as Layer from "effect/Layer";',
            'import { value } from "./value.ts";',
            "",
            'export default Alchemy.Stack("dev-lifetime", {',
            "  providers: Layer.empty,",
            "  state: Alchemy.localState(),",
            "}, Effect.succeed({ value }));",
            "",
          ].join("\n"),
        );
        yield* fs.writeFileString(valueFile, 'export const value = "first";\n');

        const child = yield* ChildProcess.make(
          "bun",
          [
            pathe.join(repositoryRoot, "packages/alchemy/bin/cli.js"),
            "dev",
            stackFile,
            "--stage",
            `dev-lifetime-${process.pid}`,
            "--data-dir",
            dataDir,
          ],
          {
            cwd: repositoryRoot,
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "3 seconds",
          },
        );
        const output = yield* Ref.make("");
        const append = (chunk: Uint8Array) =>
          Ref.update(
            output,
            (current) => current + new TextDecoder().decode(chunk),
          );
        yield* child.stdout.pipe(Stream.runForEach(append), Effect.forkScoped);
        yield* child.stderr.pipe(Stream.runForEach(append), Effect.forkScoped);

        yield* waitForOutput(output, "value: 'first'");
        expect(yield* child.isRunning).toBe(true);

        yield* fs.writeFileString(
          valueFile,
          'export const value = "second";\n',
        );
        yield* waitForOutput(output, "value: 'second'");
        expect(yield* child.isRunning).toBe(true);

        yield* child.kill({ killSignal: "SIGTERM" });
        yield* waitForStopped(child);
      }).pipe(Effect.provide(PlatformServices)),
    { timeout: 60_000 },
  );
});
