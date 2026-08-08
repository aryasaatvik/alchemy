import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import { ProfileLive } from "@/Auth/Profile.ts";
import * as AWS from "@/AWS";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { NodeServices } from "@effect/platform-node";
import { Endpoint } from "@distilled.cloud/aws";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
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
  "wires configured service endpoints into the AWS provider collection",
  () =>
    Effect.gen(function* () {
      const endpoints = yield* Endpoint.ServiceEndpoint;

      expect(endpoints.resolve("ses")).toBe("http://emulate.samva.test/ses");
      expect(endpoints.resolve("servicequotas")).toBe(
        "http://emulate.samva.test/ses",
      );
    }).pipe(
      Effect.provide(
        AWS.providers({
          serviceEndpoints: Effect.succeed({
            ses: "http://emulate.samva.test/ses",
            servicequotas: "http://emulate.samva.test/ses",
          }),
        }),
      ),
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

it.live("does not evaluate local Lambda options in live provider mode", () => {
  let evaluated = false;
  const localEnvironment = Effect.sync(() => {
    evaluated = true;
    return {
      DATABASE_URL: Redacted.make("postgres://postgres:5432/samva"),
      REDIS_URL: "redis://redis:6379",
    };
  });
  const localEndpoint = Effect.sync(() => {
    evaluated = true;
    return "http://floci:4566";
  });
  const localServiceEndpoints = Effect.sync(() => {
    evaluated = true;
    return { ses: "http://host.docker.internal:8811/ses" };
  });

  return Effect.gen(function* () {
    yield* Layer.build(
      AWS.providers({
        lambda: {
          local: {
            endpoint: localEndpoint,
            environment: localEnvironment,
            serviceEndpoints: localServiceEndpoints,
          },
        },
      }),
    );
    expect(evaluated).toBe(false);
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
  );
});
