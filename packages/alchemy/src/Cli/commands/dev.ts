import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";
import { transformTypesFlags } from "../../Util/Node.ts";
import { SPAWNER_URL_ENV_KEY } from "../../Local/RpcProviderProxy.ts";
import * as RpcSpawner from "../../Local/RpcSpawner.ts";
import { dataDir, envFile, force, profile, script, stage } from "./_shared.ts";
import { ExecStackOptions } from "./deploy.ts";

export class DevEvaluationExited extends Schema.TaggedErrorClass<DevEvaluationExited>()(
  "DevEvaluationExited",
  {
    message: Schema.String,
    exitCode: Schema.Number,
  },
) {}

/**
 * A watched evaluation is the implementation detail behind one `alchemy dev`
 * session, not a successful terminal condition for that session. Keep this
 * boundary separate from process spawning so the exit contract is testable
 * without booting a deployment graph.
 */
export const awaitEvaluationExit = <E, R>(
  exitCode: Effect.Effect<ExitCode, E, R>,
): Effect.Effect<never, E | DevEvaluationExited, R> =>
  exitCode.pipe(
    Effect.flatMap((exitCode) =>
      Effect.fail(
        new DevEvaluationExited({
          message: `alchemy dev evaluation process exited unexpectedly with status ${exitCode}.`,
          exitCode,
        }),
      ),
    ),
  );

export const devCommand = Command.make(
  "dev",
  {
    force,
    main: script,
    envFile,
    dataDir,
    stage,
    profile,
  },
  Effect.fn(
    function* (args) {
      const options = yield* Schema.encodeEffect(ExecStackOptions)({
        ...args,
        yes: true,
        dev: true,
      });
      const spawner = yield* RpcSpawner.RpcSpawner;
      // We no longer force Bun in development because this prevents us from testing in Node.
      const command =
        typeof globalThis.Bun !== "undefined"
          ? [
              "bun",
              "run",
              ...process.execArgv,
              "--watch",
              "--no-clear-screen",
              fileURLToPath(import.meta.resolve("alchemy/bin/exec.ts")),
            ]
          : [
              "node",
              ...process.execArgv,
              ...transformTypesFlags(),
              "--watch",
              "--watch-preserve-output",
              fileURLToPath(import.meta.resolve("alchemy/bin/exec.js")),
            ];
      const child = yield* ChildProcess.make(command[0], command.slice(1), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...spawner.environment,
          ALCHEMY_EXEC_OPTIONS: JSON.stringify(options),
          ALCHEMY_DEV: "true",
          [SPAWNER_URL_ENV_KEY]: spawner.url,
        },
        extendEnv: false,
        detached: false,
      });
      return yield* awaitEvaluationExit(child.exitCode);
    },
    (effect, args) =>
      Effect.provide(
        RpcSpawner.layerServer({
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        }),
      )(effect),
  ),
);
