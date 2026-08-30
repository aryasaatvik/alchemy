import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import { ProfileLive } from "@/Auth/Profile.ts";
import * as AWS from "@/AWS";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { v4 as uuidv4 } from "uuid";
it.live(
  "building the AWS provider layers should not fail for unknown profile",
  () =>
    Effect.gen(function* () {
      yield* Layer.build(AWS.providers());
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(AuthProviders, {}),
          Layer.sync(ArtifactStore, createArtifactStore),
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, {
            dev: false,
            adopt: false,
            dotAlchemy: ".alchemy",
          }),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              ALCHEMY_PROFILE: `non-existent-${uuidv4()}`,
            }),
          ),
          ProfileLive,
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
          ),
        ),
      ),
    ),
);

it.live(
  "local AWS providers expose custom and default Floci profiles to stack composition",
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.unwrap(
          Effect.succeed(
            AWS.providers({
              local: {
                endpoint: "http://localhost:4567",
                region: "eu-west-1",
                accountId: "123456789012",
                autoStart: false,
              },
            }),
          ),
        ),
      );
      const environment = Context.get(context, AWS.AWSEnvironment);
      const resolved = yield* environment;

      expect(resolved.endpoint).toBe("http://localhost:4567");
      expect(resolved.region).toBe("eu-west-1");
      expect(resolved.accountId).toBe("123456789012");

      const defaultContext = yield* Layer.build(
        AWS.providers({ local: { autoStart: false } }),
      );
      const defaultEnvironment = Context.get(
        defaultContext,
        AWS.AWSEnvironment,
      );
      const defaultResolved = yield* defaultEnvironment;

      expect(defaultResolved.endpoint).toBe("http://localhost:4566");
      expect(defaultResolved.region).toBe("us-east-1");
      expect(defaultResolved.accountId).toBe("000000000000");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(AuthProviders, {}),
          Layer.sync(ArtifactStore, createArtifactStore),
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, {
            dev: true,
            adopt: false,
            dotAlchemy: ".alchemy",
          }),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: "default" }),
          ),
          ProfileLive,
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
          ),
        ),
      ),
    ),
);
