import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as NodeV8 from "node:v8";
import { PlatformServices, runMain } from "../../Util/PlatformServices.ts";
import { viteBuildInProcess } from "./Sources/Vite.ts";
import type {
  ViteBuildChildConfig,
  ViteBuildChildResult,
} from "./ViteChild.shared.ts";

/**
 * Entry point of the one-shot Vite *build* child spawned by
 * `runViteBuildChild` (`ViteChild.ts`), with the project root as its
 * working directory. Running the build out of process is the isolation
 * boundary: vite resolves a relative root against live `process.cwd()`,
 * plugins read cwd freely, and the build's own spawns (via cross-spawn)
 * `process.chdir` the hosting process transiently — none of which is safe
 * inside the concurrent engine/test process.
 *
 * Protocol: V8-serialized {@link ViteBuildChildConfig} on stdin; the child
 * writes the V8-serialized {@link ViteBuildChildResult} to
 * `config.outputPath` and exits 0. Build logs stream over stdout/stderr;
 * a failed build exits non-zero with its cause printed once on stderr.
 */

const readConfig = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const chunks = yield* Stream.runCollect(stdio.stdin);
  return NodeV8.deserialize(Buffer.concat(chunks)) as ViteBuildChildConfig;
});

const program = Effect.gen(function* () {
  const config = yield* readConfig;
  const fs = yield* FileSystem.FileSystem;
  const { clientDirectory, base, serverBundle, externalWorkspaces } =
    yield* viteBuildInProcess(config.rootDir, config.env, {
      main: config.main,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      viteEnvironments: config.viteEnvironments,
    });
  const [bundle, workspaces] = yield* Effect.all([
    serverBundle,
    externalWorkspaces,
  ]);
  const result: ViteBuildChildResult = {
    clientDirectory,
    base,
    serverBundle: bundle,
    externalWorkspaces: Array.from(workspaces),
  };
  yield* fs.writeFile(config.outputPath, NodeV8.serialize(result));
});

// The parent streams this child's output and turns its exit code plus the
// output tail into the resource-scoped build error, so the failure cause must
// reach stderr: Vite logs only `✗ Build failed in …` for a failed build, and
// an error thrown while resolving the config (e.g. a plugin's
// `configResolved`) is logged by nothing at all. Print the cause exactly
// once here and keep `runMain`'s reporter off, which would print a second
// Effect failure report (the extra `✖` block). Interrupts (the parent killing
// the child) are not failures worth reporting.
const reportFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Console.error(Cause.pretty(cause)),
    ),
  );

runMain(reportFailure(program).pipe(Effect.provide(PlatformServices)), {
  disableErrorReporting: true,
});
