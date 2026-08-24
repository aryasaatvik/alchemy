import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { fromEnvironmentWithServiceEndpoints } from "@/AWS/Endpoint.ts";
import {
  AWS_SERVICE_ENDPOINTS_ENV_VAR,
  AWSEnvironment,
} from "@/AWS/Environment.ts";
import { localEmulatorFunctionEnvironment } from "@/AWS/Lambda/FlociFunctionProvider.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

describe("AWS provider options", () => {
  it.effect("routes configured services before the environment fallback", () =>
    Effect.gen(function* () {
      const resolver = yield* Endpoint.ServiceEndpoint;
      expect(resolver.resolve("SESv2")).toBe("http://ses.local");
      expect(resolver.resolve("Service Quotas")).toBe("http://quotas.local");
      expect(resolver.resolve("s3")).toBe("http://global.local");
    }).pipe(
      Effect.provide(
        fromEnvironmentWithServiceEndpoints(
          Effect.succeed({
            sesv2: "http://ses.local",
            servicequotas: "http://quotas.local",
          }),
        ),
      ),
      Effect.provideService(
        AWSEnvironment,
        Effect.succeed({
          accountId: "000000000000",
          region: "us-east-1",
          credentials: Effect.die("unused"),
          endpoint: "http://global.local",
        }),
      ),
    ),
  );

  it.effect("materializes the container-specific Lambda environment", () =>
    Effect.gen(function* () {
      const environment = yield* localEmulatorFunctionEnvironment(
        { AWS_ENDPOINT_URL: "http://host-only", PRESERVED: "value" },
        {
          endpoint: Effect.succeed("http://floci:4566"),
          environment: Effect.succeed({
            DATABASE_URL: Redacted.make("postgres://database"),
          }),
          serviceEndpoints: Effect.succeed({
            ses: "http://host.docker.internal:4123/ses",
          }),
        },
      );

      expect(environment.AWS_ENDPOINT_URL).toBe("http://floci:4566");
      expect(environment.PRESERVED).toBe("value");
      expect(environment.DATABASE_URL).not.toBe("postgres://database");
      expect(JSON.parse(environment[AWS_SERVICE_ENDPOINTS_ENV_VAR]!)).toEqual({
        ses: "http://host.docker.internal:4123/ses",
      });
    }),
  );
});
