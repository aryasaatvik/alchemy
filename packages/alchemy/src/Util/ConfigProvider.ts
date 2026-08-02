import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/** Shell/process configuration wins; dotenv supplies only missing values. */
export const withDotEnvFallback = (
  dotEnv: ConfigProvider.ConfigProvider,
  environment: ConfigProvider.ConfigProvider = ConfigProvider.fromEnv(),
): ConfigProvider.ConfigProvider => ConfigProvider.orElse(environment, dotEnv);

export const loadConfigProvider = (envFile: Option.Option<string>) => {
  if (Option.isSome(envFile)) {
    return ConfigProvider.fromDotEnv({ path: envFile.value }).pipe(
      Effect.map((dotEnv) => withDotEnvFallback(dotEnv)),
    );
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(".env");
    if (!exists) {
      return ConfigProvider.fromEnv();
    }
    return withDotEnvFallback(
      yield* ConfigProvider.fromDotEnv({ path: ".env" }),
    );
  });
};
