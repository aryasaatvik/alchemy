import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { fromEnvironmentWithServiceEndpoints } from "@/AWS/Endpoint.ts";
import {
  AWS_ENDPOINT_URL,
  AWS_SERVICE_ENDPOINTS,
  AWS_SERVICE_ENDPOINTS_ENV_VAR,
  AWSEnvironment,
} from "@/AWS/Environment.ts";
import { localEmulatorFunctionEnvironment } from "@/AWS/Lambda/FlociFunctionProvider.ts";
import { packEnvValue, unpackEnvValue } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

describe("AWS provider options", () => {
  it.effect("decodes runtime endpoint policy from the environment", () =>
    Effect.gen(function* () {
      expect(yield* AWS_ENDPOINT_URL).toBe("http://global.local");
      expect(yield* AWS_SERVICE_ENDPOINTS).toEqual({
        ses: "http://ses.local",
        sqs: "http://sqs.local",
      });
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            AWS_ENDPOINT_URL: "http://global.local",
            [AWS_SERVICE_ENDPOINTS_ENV_VAR]: JSON.stringify({
              ses: "http://ses.local",
              sqs: "http://sqs.local",
            }),
          },
        }),
      ),
    ),
  );

  it.effect(
    "accepts service endpoints reified by the runtime Config provider",
    () =>
      Effect.gen(function* () {
        expect(yield* AWS_SERVICE_ENDPOINTS).toEqual({
          servicequotas: "http://host.docker.internal:8800/service-quotas",
          ses: "http://host.docker.internal:8800/ses",
          sesv2: "http://host.docker.internal:8800/ses",
        });
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.make((path) =>
            Effect.succeed(
              path[0] === AWS_SERVICE_ENDPOINTS_ENV_VAR
                ? ({
                    _tag: "Value",
                    value: {
                      servicequotas:
                        "http://host.docker.internal:8800/service-quotas",
                      ses: "http://host.docker.internal:8800/ses",
                      sesv2: "http://host.docker.internal:8800/ses",
                    },
                  } as unknown as ConfigProvider.Node)
                : undefined,
            ),
          ),
        ),
      ),
  );

  it.effect("rejects malformed runtime service endpoint policy", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(AWS_SERVICE_ENDPOINTS);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe(
          "AWS::Environment::InvalidServiceEndpoints",
        );
      }
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: { [AWS_SERVICE_ENDPOINTS_ENV_VAR]: '{"sqs":""}' },
        }),
      ),
    ),
  );

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
        {
          AWS_ENDPOINT_URL: "http://host-only",
          DATABASE_URL: packEnvValue(
            Redacted.make("postgres://127.0.0.1:54329/database"),
          ),
          REDIS_URL: packEnvValue(Redacted.make("redis://127.0.0.1:56379/2")),
          PRESERVED: "value",
        },
        {
          endpoint: Effect.succeed("http://floci:4566"),
          environment: Effect.succeed({
            DATABASE_URL: Redacted.make("postgres://postgres:5432/database"),
            PLACED_ONLY: Redacted.make("placed-value"),
            REDIS_URL: Redacted.make("redis://redis:6379/2"),
          }),
          serviceEndpoints: Effect.succeed({
            ses: "http://host.docker.internal:4123/ses",
          }),
        },
      );

      expect(environment.AWS_ENDPOINT_URL).toBe("http://floci:4566");
      expect(environment.PRESERVED).toBe("value");
      expect(environment.PLACED_ONLY).toBe("placed-value");
      expect(
        Redacted.value(
          unpackEnvValue<Redacted.Redacted<string>>(environment.DATABASE_URL)!,
        ),
      ).toBe("postgres://postgres:5432/database");
      expect(
        Redacted.value(
          unpackEnvValue<Redacted.Redacted<string>>(environment.REDIS_URL)!,
        ),
      ).toBe("redis://redis:6379/2");
      expect(JSON.parse(environment[AWS_SERVICE_ENDPOINTS_ENV_VAR]!)).toEqual({
        ses: "http://host.docker.internal:4123/ses",
      });
    }),
  );
});
