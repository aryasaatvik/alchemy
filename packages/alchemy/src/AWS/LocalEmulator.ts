/**
 * Lifecycle helpers for a LocalStack-compatible AWS emulator. The default is
 * Floci, whose Docker-backed Lambda implementation needs the Docker socket.
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

export const DEFAULT_LOCAL_ENDPOINT = "http://localhost:4566";

const FLOCI_CONTAINER_NAME = "floci";
const FLOCI_IMAGE = "floci/floci:latest";

export class LocalEmulatorError extends Error {
  readonly _tag = "LocalEmulatorError";
}

const isReachable = (endpoint: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(endpoint).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.succeed(error.reason._tag !== "TransportError"),
      ),
    );
  });

const docker = (args: string[]) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make("docker", args, {
      shell: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return yield* handle.exitCode;
  }).pipe(
    Effect.scoped,
    Effect.catch(() => Effect.succeed(-1)),
  );

/**
 * Ensure a local emulator is reachable. A configured non-default endpoint is
 * never started implicitly: an unavailable Compose service must fail rather
 * than silently changing the machine's execution topology.
 */
export const ensureLocalEmulator = Effect.fn(function* (options: {
  endpoint: string;
  autoStart: boolean;
}) {
  if (yield* isReachable(options.endpoint)) return;

  if (!options.autoStart) {
    return yield* Effect.fail(
      new LocalEmulatorError(
        `no local AWS emulator is listening at ${options.endpoint}`,
      ),
    );
  }

  yield* Effect.logInfo(
    `starting local AWS emulator (${FLOCI_IMAGE}) at ${options.endpoint}`,
  );
  const started = yield* docker(["start", FLOCI_CONTAINER_NAME]);
  if (started !== 0) {
    const ran = yield* docker([
      "run",
      "-d",
      "--name",
      FLOCI_CONTAINER_NAME,
      "-p",
      "4566:4566",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-u",
      "root",
      FLOCI_IMAGE,
    ]);
    if (ran !== 0) {
      return yield* Effect.fail(
        new LocalEmulatorError(
          `failed to start the ${FLOCI_CONTAINER_NAME} Docker container — is Docker running?`,
        ),
      );
    }
  }

  return yield* isReachable(options.endpoint).pipe(
    Effect.flatMap((up) =>
      up
        ? Effect.void
        : Effect.fail(
            new LocalEmulatorError(
              `local AWS emulator did not become reachable at ${options.endpoint}`,
            ),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "LocalEmulatorError",
      schedule: Schedule.spaced("1 second"),
      times: 120,
    }),
  );
});
