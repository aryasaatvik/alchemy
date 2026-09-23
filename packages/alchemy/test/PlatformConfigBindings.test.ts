import { Platform } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import type { Resource } from "@/Resource.ts";
import { unpackEnvValue } from "@/RuntimeContext.ts";
import { inMemoryState } from "@/State/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

interface ConfigHost extends Resource<
  "Test.ConfigHost",
  { env?: Record<string, unknown> },
  { ready: true },
  { env?: Record<string, unknown> }
> {}

const boundKeys: string[] = [];

const ConfigHost: any = Platform<ConfigHost>("Test.ConfigHost", {
  createRuntimeContext: (id) => ({
    Type: "Test.ConfigHost",
    id,
    env: {},
    set: (key) =>
      Effect.sync(() => {
        boundKeys.push(key);
        return key;
      }),
    get: () => Effect.succeed(undefined),
  }),
});

const providers = Provider.succeed(ConfigHost, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {
    return undefined;
  }),
  reconcile: Effect.fn(function* () {
    return { ready: true as const };
  }),
  delete: Effect.fn(function* () {}),
});

const { test } = Test.make({ providers, state: inMemoryState() });

test.provider(
  "an absent optional field skips synthetic binding and preserves concrete config bindings",
  (stack) =>
    Effect.gen(function* () {
      boundKeys.length = 0;

      yield* stack.deploy(
        ConfigHost(
          "ConfigHost",
          {},
          Effect.gen(function* () {
            const optional = yield* Config.schema(
              Schema.Struct({ maybe: Schema.optional(Schema.String) }),
            );
            expect(optional).toEqual({});

            const concrete = yield* Config.String(
              "ALCHEMY_TEST_PRESENT_CONFIG",
            );
            expect(concrete).toBe("present");
            return {};
          }),
        ),
      );

      expect(boundKeys).toEqual(["ALCHEMY_TEST_PRESENT_CONFIG"]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ALCHEMY_TEST_PRESENT_CONFIG: "present",
          }),
        ),
      ),
    ),
);

// A deployed host's runtime context answers from its raw environment through
// `unpackEnvValue`, as `AWS.Lambda.Function` does.
const runtimeEnv: Record<string, string> = {
  ALCHEMY_TEST_JSON_CONFIG: JSON.stringify({ ses: "http://ses.local" }),
};

const RuntimeConfigHost: any = Platform<ConfigHost>("Test.ConfigHost", {
  createRuntimeContext: (id) => ({
    Type: "Test.ConfigHost",
    id,
    env: {},
    set: (key) => Effect.succeed(key),
    get: <T>(key: string) =>
      Effect.sync(() => unpackEnvValue<T>(runtimeEnv[key])),
  }),
});

test.provider(
  "a JSON-valued variable reads as its string at runtime",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        RuntimeConfigHost(
          "RuntimeConfigHost",
          {},
          Effect.gen(function* () {
            expect(yield* Config.String("ALCHEMY_TEST_JSON_CONFIG")).toBe(
              runtimeEnv.ALCHEMY_TEST_JSON_CONFIG,
            );
            expect(
              yield* Config.schema(
                Schema.fromJsonString(Schema.Struct({ ses: Schema.String })),
                "ALCHEMY_TEST_JSON_CONFIG",
              ),
            ).toEqual({ ses: "http://ses.local" });
            return {};
          }),
        ),
      );
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
        ),
      ),
    ),
);
