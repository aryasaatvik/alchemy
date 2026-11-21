import { describe, expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AlchemyContext } from "@/AlchemyContext.ts";
import * as ProviderSessionConfig from "@/Local/ProviderSessionConfig.ts";
import {
  fromEnv,
  encodeSessionEnvironment,
  decodeSessionEnvironment,
  layer,
  RPC_SERVER_ENVIRONMENT_KEY,
  type RpcServerEnvironment,
} from "@/Local/RpcServerEnvironment.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";

const sessionEnv = {
  alchemyContext: {
    dotAlchemy: "/tmp/.alchemy",
    dev: true,
    adopt: false,
  },
  stack: {
    name: "my-stack",
    stage: "dev",
  },
};

const sampleEnv: RpcServerEnvironment = {
  profile: undefined,
  envFile: undefined,
  ...sessionEnv,
};

describe("Local.RpcServerEnvironment", { tags: ["unit", "local"] }, () => {
  it.effect("layer() provides Stack, Stage, and AlchemyContext", () =>
    Effect.gen(function* () {
      const observed = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const stage = yield* Stage;
        const ctx = yield* AlchemyContext;
        return { stack, stage, ctx };
      }).pipe(
        Effect.provide(
          Layer.provide(
            layer({ profile: undefined, envFile: undefined, ...sessionEnv }),
            PlatformServices,
          ),
        ),
      );

      expect(observed.stack.name).toBe("my-stack");
      expect(observed.stack.stage).toBe("dev");
      expect(observed.stage).toBe("dev");
      expect(observed.ctx.dotAlchemy).toBe("/tmp/.alchemy");
      expect(observed.ctx.dev).toBe(true);
    }),
  );

  it.effect("fromEnv() roundtrips a serialized RpcServerEnvironment", () =>
    Effect.gen(function* () {
      const environment = ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            [RPC_SERVER_ENVIRONMENT_KEY]: JSON.stringify(sampleEnv),
          },
        }),
      );
      const stack = yield* Stack.pipe(
        Effect.provide(Layer.provide(fromEnv(), Layer.mergeAll(PlatformServices, environment))),
      );
      expect(stack.name).toBe(sessionEnv.stack.name);
      expect(stack.stage).toBe(sessionEnv.stack.stage);
    }),
  );

  it.effect("preserves provider endpoint and profile options across the session boundary", () =>
    Effect.gen(function* () {
      const aws = {
        profile: "local",
        endpoint: "http://127.0.0.1:4566",
        serviceEndpoints: { SESv2: "http://127.0.0.1:8800/ses" },
      };
      const encoded = encodeSessionEnvironment({ ...sessionEnv, providers: { AWS: aws } });
      const configured = layer({
        profile: "local",
        envFile: undefined,
        ...decodeSessionEnvironment(encoded),
      });
      const observed = yield* ProviderSessionConfig.get("AWS").pipe(
        Effect.provide(Layer.provide(configured, PlatformServices)),
      );
      expect(observed).toEqual(aws);
      expect(encodeSessionEnvironment(sessionEnv)).not.toBe(encoded);
    }),
  );

  it.effect("merges provider namespaces without requiring unconfigured providers", () =>
    Effect.gen(function* () {
      expect(yield* ProviderSessionConfig.get("AWS")).toBeUndefined();
      const configured = ProviderSessionConfig.layer("AWS", { profile: "local" }).pipe(
        Layer.provide(ProviderSessionConfig.layer("Cloudflare", { accountId: "test-account" })),
      );
      const observed = yield* Effect.all([
        ProviderSessionConfig.get("AWS"),
        ProviderSessionConfig.get("Cloudflare"),
      ]).pipe(Effect.provide(configured));
      expect(observed).toEqual([{ profile: "local" }, { accountId: "test-account" }]);
    }),
  );

  it("exports the canonical environment variable key", () => {
    expect(RPC_SERVER_ENVIRONMENT_KEY).toBe("ALCHEMY_RPC_SERVER_ENVIRONMENT");
  });
});
