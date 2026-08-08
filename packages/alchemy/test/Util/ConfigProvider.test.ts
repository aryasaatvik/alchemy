import {
  loadEvaluationEnvironment,
  withDotEnvFallback,
  withEvaluationEnvironment,
} from "@/Util/ConfigProvider";
import { PlatformServices } from "@/Util/PlatformServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { describe, expect, test } from "alchemy-test";

const resolve = (
  environment: Record<string, string>,
  dotenv: Record<string, string>,
) =>
  Effect.runSync(
    Effect.all({
      overridden: Config.string("OVERRIDDEN"),
      fallback: Config.string("FALLBACK"),
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          withDotEnvFallback(
            ConfigProvider.fromUnknown(dotenv),
            ConfigProvider.fromUnknown(environment),
          ),
        ),
      ),
    ),
  );

describe("withDotEnvFallback", () => {
  test("process configuration overrides dotenv values", () => {
    expect(
      resolve(
        { OVERRIDDEN: "process" },
        { OVERRIDDEN: "dotenv", FALLBACK: "dotenv-fallback" },
      ),
    ).toEqual({ overridden: "process", fallback: "dotenv-fallback" });
  });
});

describe("evaluation environment", () => {
  test.effect("inherited values override an explicit dotenv file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-evaluation-environment-",
      });
      const envFile = path.join(directory, "managed.env");
      yield* fs.writeFileString(
        envFile,
        "OVERRIDDEN=dotenv\nFALLBACK=dotenv-fallback\nEMPTY=\n",
      );

      const environment = yield* loadEvaluationEnvironment(
        Option.some(envFile),
        { OVERRIDDEN: "acquisition", ACQUIRED: "allocated" },
      );

      expect(environment).toMatchObject({
        OVERRIDDEN: "acquisition",
        FALLBACK: "dotenv-fallback",
        EMPTY: "",
        ACQUIRED: "allocated",
      });
    }).pipe(Effect.provide(PlatformServices)),
  );

  test.effect("scopes missing dotenv values into raw process.env", () => {
    const key = `ALCHEMY_EVALUATION_TEST_${crypto.randomUUID().replaceAll("-", "_")}`;
    return withEvaluationEnvironment({ [key]: "managed" })(
      Effect.sync(() => process.env[key]),
    ).pipe(
      Effect.tap((value) => Effect.sync(() => expect(value).toBe("managed"))),
      Effect.andThen(
        Effect.sync(() => expect(process.env[key]).toBeUndefined()),
      ),
    );
  });

  test.effect("never overwrites an existing raw process value", () => {
    const key = `ALCHEMY_EVALUATION_TEST_${crypto.randomUUID().replaceAll("-", "_")}`;
    process.env[key] = "acquisition";
    return withEvaluationEnvironment({ [key]: "dotenv" })(
      Effect.sync(() => process.env[key]),
    ).pipe(
      Effect.tap((value) =>
        Effect.sync(() => expect(value).toBe("acquisition")),
      ),
      Effect.ensuring(Effect.sync(() => delete process.env[key])),
    );
  });
});
