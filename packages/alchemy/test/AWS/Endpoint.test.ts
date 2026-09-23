import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import { ProfileStoreLive } from "@/Auth/Profile.ts";
import * as AWS from "@/AWS";
import * as AwsEndpoint from "@/AWS/Endpoint.ts";
import {
  AWS_ENDPOINT_URL,
  AWS_SERVICE_ENDPOINTS,
  AWS_SERVICE_ENDPOINTS_ENV_VAR,
} from "@/AWS/Environment.ts";
import { captureAwsEnvironment } from "@/AWS/Local/ProviderContext.ts";
import { reifyBoundConfigProvider } from "@/Runtime.ts";
import { packEnvValue } from "@/RuntimeContext.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { Endpoint } from "@distilled.cloud/aws";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const stackServices = (dev: boolean) =>
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
      dev,
      adopt: false,
      dotAlchemy: ".alchemy",
    }),
    ConfigProvider.layer(ConfigProvider.fromUnknown({})),
    ProfileStoreLive,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
    ),
  );

const runtimeEnv = (env: Record<string, string>) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv({ env }),
  );

describe("AWS service endpoints", { tags: ["unit", "provider:aws"] }, () => {
  it("matches SDK service IDs case- and punctuation-insensitively", () => {
    const resolver = AwsEndpoint.serviceEndpointResolver(
      { sesv2: "http://ses.local", "Service Quotas": "http://quotas.local" },
      "http://gateway.local",
    );
    expect(resolver.resolve("SESv2")).toBe("http://ses.local");
    expect(resolver.resolve("Service Quotas")).toBe("http://quotas.local");
    expect(resolver.resolve("service_quotas")).toBe("http://quotas.local");
    expect(resolver.resolve("S3")).toBe("http://gateway.local");
    expect(
      AwsEndpoint.serviceEndpointResolver({ SES: "http://ses.local" }).resolve(
        "S3",
      ),
    ).toBeUndefined();
  });

  it.effect("routes configured services and leaves the rest to AWS", () =>
    Effect.gen(function* () {
      expect(yield* Endpoint.resolve("SESv2")).toBe("http://ses.local");
      expect(yield* Endpoint.resolve("SES")).toBe("http://ses.local");
      expect(yield* Endpoint.resolve("S3")).toBeUndefined();
    }).pipe(
      Effect.provide(
        AWS.providers({
          serviceEndpoints: {
            ses: "http://ses.local",
            SESv2: "http://ses.local",
          },
        }),
      ),
      Effect.provide(stackServices(false)),
    ),
  );

  it.effect("pins the registration-time service endpoints on providers", () =>
    Effect.gen(function* () {
      const captured = yield* captureAwsEnvironment.pipe(
        Effect.provide(AwsEndpoint.services({ SES: "http://pinned.local" })),
      );
      const resolved = yield* Endpoint.resolve("SES").pipe(
        Effect.provide(captured),
        Effect.provide(AwsEndpoint.services({ SES: "http://ambient.local" })),
      );
      expect(resolved).toBe("http://pinned.local");

      const unpinned = yield* captureAwsEnvironment;
      const none = yield* Endpoint.resolve("SES").pipe(
        Effect.provide(unpinned),
        Effect.provide(AwsEndpoint.services({ SES: "http://ambient.local" })),
      );
      expect(none).toBeUndefined();
    }),
  );

  it.effect("an explicit operation endpoint wins over the service map", () =>
    Effect.gen(function* () {
      expect(yield* Endpoint.resolve("SES")).toBe("http://explicit.local");
    }).pipe(
      Effect.provide(AwsEndpoint.of("http://explicit.local")),
      Effect.provide(AwsEndpoint.services({ SES: "http://ses.local" })),
    ),
  );
});

describe(
  "AWS runtime endpoint config",
  { tags: ["unit", "provider:aws"] },
  () => {
    it.effect("decodes the global and per-service runtime endpoints", () =>
      Effect.gen(function* () {
        expect(yield* AWS_ENDPOINT_URL).toBe("http://gateway.local");
        expect(yield* AWS_SERVICE_ENDPOINTS).toEqual({
          ses: "http://ses.local",
          sesv2: "http://ses.local",
        });
      }).pipe(
        runtimeEnv({
          AWS_ENDPOINT_URL: "http://gateway.local",
          [AWS_SERVICE_ENDPOINTS_ENV_VAR]: JSON.stringify({
            ses: "http://ses.local",
            sesv2: "http://ses.local",
          }),
        }),
      ),
    );

    it.effect("resolves undefined when unset", () =>
      Effect.gen(function* () {
        expect(yield* AWS_ENDPOINT_URL).toBeUndefined();
        expect(yield* AWS_SERVICE_ENDPOINTS).toBeUndefined();
      }).pipe(runtimeEnv({})),
    );

    it.effect("decodes a Config-bound (Redacted-marked) runtime value", () =>
      Effect.gen(function* () {
        expect(yield* AWS_SERVICE_ENDPOINTS).toEqual({
          ses: "http://ses.local",
        });
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(
            ConfigProvider.fromEnv({
              env: {
                [AWS_SERVICE_ENDPOINTS_ENV_VAR]: packEnvValue(
                  Redacted.make(JSON.stringify({ ses: "http://ses.local" })),
                ),
              },
            }),
            {},
          ),
        ),
      ),
    );

    for (const malformed of ["not json", "[]", '{"ses":""}', '{"ses":1}']) {
      it.effect(`rejects malformed service endpoints: ${malformed}`, () =>
        Effect.gen(function* () {
          const result = yield* Effect.result(AWS_SERVICE_ENDPOINTS);
          expect(Result.isFailure(result)).toBe(true);
        }).pipe(runtimeEnv({ [AWS_SERVICE_ENDPOINTS_ENV_VAR]: malformed })),
      );
    }
  },
);
