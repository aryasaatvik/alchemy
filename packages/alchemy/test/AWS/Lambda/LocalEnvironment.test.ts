import { AWS_SERVICE_ENDPOINTS_ENV_VAR } from "@/AWS/Environment.ts";
import { placeLocalLambdaEnvironment } from "@/AWS/Lambda/FlociFunctionProvider.ts";
import {
  awsSessionConfig,
  currentAwsSessionConfig,
} from "@/AWS/Local/FlociServices.ts";
import { ProviderSessionConfig } from "@/Local/ProviderSessionConfig.ts";
import { packEnvValue, unpackEnvValue } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const secret = (value: string) => packEnvValue(Redacted.make(value));

/** The AWS session entry after a JSON round trip, as the sidecar sees it. */
const overTheWire = (options: Parameters<typeof awsSessionConfig>[0]) =>
  Effect.gen(function* () {
    const config = yield* ProviderSessionConfig;
    return yield* currentAwsSessionConfig.pipe(
      Effect.provideService(
        ProviderSessionConfig,
        JSON.parse(JSON.stringify(config)),
      ),
    );
  }).pipe(Effect.provide(Layer.fresh(awsSessionConfig(options))));

describe(
  "local Lambda environment placement",
  { tags: ["unit", "provider:aws"] },
  () => {
    it("leaves the environment alone without a placement", () => {
      const environment = { A: "1" };
      expect(placeLocalLambdaEnvironment(environment, undefined)).toBe(
        environment,
      );
    });

    it.effect(
      "places overrides, endpoints and secrets across the session",
      () =>
        Effect.gen(function* () {
          const config = yield* overTheWire({
            local: {
              lambda: {
                endpoint: "http://floci:4566",
                serviceEndpoints: {
                  ses: "http://host.docker.internal:8800/ses",
                },
                environment: {
                  DATABASE_URL: Redacted.make("postgres://postgres:5432/db"),
                  REDIS_URL: Redacted.make("redis://redis:6379"),
                  PORT: "5432",
                  AWS_ENDPOINT_URL: "http://ignored",
                },
              },
            },
          });
          const placed = placeLocalLambdaEnvironment(
            {
              DATABASE_URL: secret("postgres://127.0.0.1:54329/db"),
              REDIS_URL: "redis://127.0.0.1:56379",
              AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
              KEPT: "kept",
            },
            config.local?.lambda,
          );

          expect(placed).toEqual({
            // A Config-bound secret stays marker-packed.
            DATABASE_URL: secret("postgres://postgres:5432/db"),
            // A raw value stays raw, even when the override was Redacted.
            REDIS_URL: "redis://redis:6379",
            // JSON-looking strings are not reinterpreted.
            PORT: "5432",
            AWS_ENDPOINT_URL: "http://floci:4566",
            [AWS_SERVICE_ENDPOINTS_ENV_VAR]: JSON.stringify({
              ses: "http://host.docker.internal:8800/ses",
            }),
            KEPT: "kept",
          });
          expect(
            Redacted.isRedacted(unpackEnvValue<unknown>(placed.DATABASE_URL)),
          ).toBe(true);
        }),
    );
  },
);
