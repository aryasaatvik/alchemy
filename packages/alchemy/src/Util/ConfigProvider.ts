import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/** Shell/process configuration wins; dotenv supplies only missing values. */
export const withDotEnvFallback = (
  dotEnv: ConfigProvider.ConfigProvider,
  environment: ConfigProvider.ConfigProvider = ConfigProvider.fromEnv(),
): ConfigProvider.ConfigProvider => ConfigProvider.orElse(environment, dotEnv);

const definedEnvironment = (
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const providerEnvironment = Effect.fn("ConfigProvider.providerEnvironment")(
  function* (provider: ConfigProvider.ConfigProvider) {
    const environment: Record<string, string> = {};

    const visit = (
      path: ConfigProvider.Path,
    ): Effect.Effect<void, ConfigProvider.SourceError> =>
      provider.load(path).pipe(
        Effect.flatMap((node) => {
          if (node === undefined) return Effect.void;
          if (path.length > 0 && node.value !== undefined) {
            environment[path.join("_")] = node.value;
          }
          switch (node._tag) {
            case "Value":
              return Effect.void;
            case "Record":
              return Effect.forEach(node.keys, (key) => visit([...path, key]), {
                discard: true,
              });
            case "Array":
              return Effect.forEach(
                Array.from({ length: node.length }, (_, index) => index),
                (index) => visit([...path, index]),
                { discard: true },
              );
          }
        }),
      );

    yield* visit([]);
    return environment;
  },
);

/**
 * Captures the complete environment for one evaluation. The inherited process
 * environment is authoritative; the selected dotenv file supplies only
 * missing values. Callers pass this exact snapshot to watched evaluation and
 * retained sidecar children so every process observes the same inputs.
 */
export const loadEvaluationEnvironment = Effect.fn(
  "ConfigProvider.loadEvaluationEnvironment",
)(function* (
  envFile: Option.Option<string>,
  inherited: NodeJS.ProcessEnv | Readonly<Record<string, string>> = process.env,
) {
  const environment = definedEnvironment(inherited);
  const fs = yield* FileSystem.FileSystem;
  const path = Option.isSome(envFile)
    ? envFile.value
    : (yield* fs.exists(".env"))
      ? ".env"
      : undefined;
  if (path === undefined) return environment;

  const dotEnv = yield* ConfigProvider.fromDotEnv({
    path,
    preserveEmptyStrings: true,
  }).pipe(Effect.flatMap(providerEnvironment));
  return { ...dotEnv, ...environment };
});

/**
 * Makes an evaluation snapshot visible to raw `process.env` readers for the
 * lifetime of `effect`, then restores every value it supplied. Existing
 * process values are never overwritten.
 */
export const withEvaluationEnvironment =
  (environment: Readonly<Record<string, string>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const supplied: string[] = [];
        for (const [key, value] of Object.entries(environment)) {
          if (process.env[key] !== undefined) continue;
          process.env[key] = value;
          supplied.push(key);
        }
        return supplied;
      }),
      () => effect,
      (supplied) =>
        Effect.sync(() => {
          for (const key of supplied) delete process.env[key];
        }),
    );

export const loadConfigProvider = (envFile: Option.Option<string>) =>
  loadEvaluationEnvironment(envFile).pipe(
    Effect.map((environment) => ConfigProvider.fromEnv({ env: environment })),
  );
