import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Platform, type PlatformProps } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import type { Resource } from "@/Resource.ts";
import { type BaseRuntimeContext, CurrentRuntimeContext } from "@/RuntimeContext.ts";
import { unpackEnvValue } from "@/RuntimeContext.ts";
import { inMemoryState } from "@/State/index.ts";

interface ConfigHostProps extends PlatformProps {
  env?: Record<string, unknown>;
}

interface ConfigHost extends Resource<
  "Test.ConfigHost",
  ConfigHostProps,
  { ready: true },
  { env?: Record<string, unknown> }
> {}

class HostService extends Context.Service<HostService, string>()("Test.ConfigHostService") {}

const boundKeys: string[] = [];
const reconciledEnv: Array<Record<string, unknown> | undefined> = [];

const ConfigHost: Platform<ConfigHost, HostService, {}, BaseRuntimeContext> = Platform<ConfigHost>(
  "Test.ConfigHost",
  {
    createRuntimeContext: (id) => ({
      Type: "Test.ConfigHost",
      id,
      env: {},
      hostServices: Layer.succeed(HostService, id),
      set: (key) =>
        Effect.sync(() => {
          boundKeys.push(key);
          return key;
        }),
      get: () => Effect.succeed(undefined),
    }),
  },
);

const providers = Provider.succeed(ConfigHost, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {
    return undefined;
  }),
  reconcile: Effect.fn(function* ({ news }) {
    reconciledEnv.push(news.env);
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

            const concrete = yield* Config.String("ALCHEMY_TEST_PRESENT_CONFIG");
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
  ALCHEMY_TEST_FALSE_CONFIG: "false",
  ALCHEMY_TEST_ZERO_CONFIG: "0",
  ALCHEMY_TEST_NULL_CONFIG: "null",
  ALCHEMY_TEST_EMPTY_CONFIG: "",
};

const RuntimeConfigHost: Platform<ConfigHost, never, {}, BaseRuntimeContext> = Platform<ConfigHost>(
  "Test.ConfigHost",
  {
    createRuntimeContext: (id) => ({
      Type: "Test.ConfigHost",
      id,
      env: {},
      hostServices: Layer.succeed(HostService, id),
      set: (key) => Effect.succeed(key),
      get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(runtimeEnv[key])),
    }),
  },
);

test.provider("a JSON-valued variable reads as its string at runtime", (stack) =>
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
          for (const key of [
            "ALCHEMY_TEST_FALSE_CONFIG",
            "ALCHEMY_TEST_ZERO_CONFIG",
            "ALCHEMY_TEST_NULL_CONFIG",
            "ALCHEMY_TEST_EMPTY_CONFIG",
          ]) {
            expect(yield* Config.String(key)).toBe(runtimeEnv[key]);
          }
          return {};
        }),
      ),
    );
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }))),
  ),
);

test.provider(
  "a key the host's env declares keeps its declared value instead of the captured read",
  (stack) =>
    Effect.gen(function* () {
      boundKeys.length = 0;
      reconciledEnv.length = 0;

      yield* stack.deploy(
        ConfigHost(
          "DeclaredEnvHost",
          { env: { ALCHEMY_TEST_DECLARED_CONFIG: "declared" } },
          Effect.gen(function* () {
            yield* Config.String("ALCHEMY_TEST_DECLARED_CONFIG");
            yield* Config.String("ALCHEMY_TEST_PRESENT_CONFIG");
            return {};
          }),
        ),
      );

      expect(boundKeys).toEqual(["ALCHEMY_TEST_PRESENT_CONFIG"]);
      expect(reconciledEnv).toEqual([{ ALCHEMY_TEST_DECLARED_CONFIG: "declared" }]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ALCHEMY_TEST_DECLARED_CONFIG: "deploy-machine",
            ALCHEMY_TEST_PRESENT_CONFIG: "present",
          }),
        ),
      ),
    ),
);

class SharedBinding extends Context.Service<SharedBinding, { host: string }>()(
  "Test.SharedBinding",
) {}

const hostInit = (shared: Layer.Layer<SharedBinding>) =>
  Effect.gen(function* () {
    yield* SharedBinding;
    return {};
  }).pipe(Effect.provide(shared));

test.provider("a shared init layer builds separately for each plan host", (stack) =>
  Effect.gen(function* () {
    const builtFor: string[] = [];
    const shared = Layer.effect(
      SharedBinding,
      Effect.gen(function* () {
        const host = yield* CurrentRuntimeContext;
        builtFor.push(host!.id);
        return { host: host!.id };
      }),
    );
    yield* stack.deploy(
      Effect.gen(function* () {
        yield* ConfigHost("First", {}, hostInit(shared));
        yield* ConfigHost("Second", {}, hostInit(shared));
      }),
    );
    expect(builtFor).toEqual(["First", "Second"]);
  }),
);

test.provider(
  "a nested runtime reference skips init and preserves its parent's memo map",
  (stack) =>
    Effect.gen(function* () {
      const previous = globalThis.__ALCHEMY_RUNTIME__;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          globalThis.__ALCHEMY_RUNTIME__ = true;
        }),
        () =>
          Effect.sync(() => {
            globalThis.__ALCHEMY_RUNTIME__ = previous;
          }),
      );
      let builds = 0;
      let childInits = 0;
      const shared = Layer.effect(
        SharedBinding,
        Effect.sync(() => ({ host: String(++builds) })),
      );
      yield* stack.deploy(
        ConfigHost(
          "Parent",
          {},
          Effect.gen(function* () {
            const parent = yield* SharedBinding;
            yield* ConfigHost(
              "Child",
              {},
              Effect.gen(function* () {
                childInits++;
                const child = yield* SharedBinding;
                expect(child).toBe(parent);
                return {};
              }).pipe(Effect.provide(shared)),
            );
            return {};
          }).pipe(Effect.provide(shared)),
        ),
      );
      expect(builds).toBe(1);
      expect(childInits).toBe(0);
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
      ),
      Effect.scoped,
    ),
);

for (const runtime of [false, true]) {
  test.provider(
    runtime
      ? "nested runtime hosts skip props, body, listeners and exports while the root initializes"
      : "nested plan hosts evaluate props, body, listeners, exports and bindings",
    (stack) =>
      Effect.gen(function* () {
        const events: string[] = [];
        const Host: Platform<ConfigHost, never, {}, BaseRuntimeContext> = Platform<ConfigHost>(
          "Test.ConfigHost",
          {
            transformProps: (id, props) =>
              Effect.sync(() => {
                events.push(`${id}:transform`);
                return props;
              }),
            onCreate: (host) =>
              Effect.sync(() => {
                events.push(`${host.LogicalId}:create`);
              }),
            createRuntimeContext: (id) => {
              events.push(`${id}:context`);
              return {
                Type: "Test.ConfigHost",
                id,
                env: {},
                set: (key) =>
                  Effect.sync(() => {
                    events.push(`${id}:binding`);
                    return key;
                  }),
                get: () => Effect.succeed(undefined),
                serve: () =>
                  Effect.sync(() => {
                    events.push(`${id}:listen`);
                  }),
                exports: Effect.sync(() => {
                  events.push(`${id}:exports`);
                  return {};
                }),
              };
            },
          },
        );
        const props = (id: string) =>
          Effect.sync(() => {
            events.push(`${id}:props`);
            return {};
          });
        const body = (id: string) =>
          Effect.gen(function* () {
            events.push(`${id}:body`);
            yield* Config.String("ALCHEMY_TEST_PRESENT_CONFIG");
            return { fetch: Effect.succeed(HttpServerResponse.text("ready")) };
          });
        class TaggedChild extends Host<TaggedChild>()("TaggedChild") {}

        yield* stack.destroy();
        const previous = globalThis.__ALCHEMY_RUNTIME__;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            globalThis.__ALCHEMY_RUNTIME__ = runtime;
          }),
          () =>
            Effect.sync(() => {
              globalThis.__ALCHEMY_RUNTIME__ = previous;
            }),
        );
        yield* stack.deploy(
          Host(
            "Root",
            props("Root"),
            Effect.gen(function* () {
              const child = yield* Host("InlineChild", props("InlineChild"), body("InlineChild"));
              expect(child.LogicalId).toBe("InlineChild");
              const tagged = yield* TaggedChild.pipe(
                Effect.provide(TaggedChild.make(props("TaggedChild"), body("TaggedChild"))),
              );
              expect(tagged.LogicalId).toBe("TaggedChild");
              return yield* body("Root");
            }),
          ),
        );
        for (const id of ["Root", "InlineChild", "TaggedChild"]) {
          const stages = events.filter(
            (event) => event.startsWith(`${id}:`) && event !== `${id}:binding`,
          );
          expect(stages.sort()).toEqual(
            (runtime && id !== "Root"
              ? []
              : [
                  "props",
                  "transform",
                  "context",
                  "create",
                  "body",
                  "listen",
                  "exports",
                  ...(!runtime && id === "TaggedChild" ? ["create"] : []),
                ].map((stage) => `${id}:${stage}`)
            ).sort(),
          );
          expect(events.includes(`${id}:binding`)).toBe(!runtime);
        }
        yield* stack.destroy();
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            ALCHEMY_PHASE: runtime ? "runtime" : "plan",
            ALCHEMY_TEST_PRESENT_CONFIG: "present",
          }),
        ),
        Effect.scoped,
      ),
  );
}

test.provider("host services remain available to each host's init", (stack) =>
  Effect.gen(function* () {
    const observed: string[] = [];
    const init = Effect.gen(function* () {
      observed.push(yield* HostService);
      return {};
    });
    yield* stack.deploy(
      Effect.gen(function* () {
        yield* ConfigHost("First", {}, init);
        yield* ConfigHost("Second", {}, init);
      }),
    );
    expect(observed).toEqual(["First", "Second"]);
  }),
);
