import { withDotEnvFallback } from "@/Util/ConfigProvider";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
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
