import {
  applyEnvRegionOverride,
  localAwsCredentials,
} from "@/AWS/AuthProvider.ts";
import * as AwsEndpoint from "@/AWS/Endpoint.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Endpoint } from "@distilled.cloud/aws";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

// Simulates credentials resolved from an SSO profile whose ~/.aws/config
// region differs from the region the user explicitly set in the environment.
const profileCreds = { accountId: "123456789012", region: "us-west-2" };

describe("applyEnvRegionOverride", () => {
  it.effect("AWS_REGION overrides the profile region", () =>
    Effect.gen(function* () {
      const creds = yield* applyEnvRegionOverride(profileCreds);
      expect(creds.region).toBe("us-east-2");
      expect(creds.accountId).toBe("123456789012");
    }).pipe(withEnv({ AWS_REGION: "us-east-2" })),
  );

  // AWS_DEFAULT_REGION is a default, not an override — the profile's region
  // is explicit configuration and must win over it.
  it.effect("AWS_DEFAULT_REGION does NOT override the profile region", () =>
    Effect.gen(function* () {
      const creds = yield* applyEnvRegionOverride(profileCreds);
      expect(creds.region).toBe("us-west-2");
    }).pipe(withEnv({ AWS_DEFAULT_REGION: "eu-west-1" })),
  );

  it.effect("falls back to the profile region when no env is set", () =>
    Effect.gen(function* () {
      const creds = yield* applyEnvRegionOverride(profileCreds);
      expect(creds.region).toBe("us-west-2");
    }).pipe(withEnv({})),
  );
});

describe("local AWS auth", () => {
  it.effect("uses a selected 12-digit account as the signing access key", () =>
    Effect.gen(function* () {
      const resolved = yield* localAwsCredentials({
        method: "local",
        accountId: "123456789012",
        endpoint: "http://floci.test:4566",
        region: "eu-west-1",
      });
      const credentials = yield* resolved.credentials;

      expect(resolved.accountId).toBe("123456789012");
      expect(Redacted.value(credentials.accessKeyId)).toBe("123456789012");
      expect(resolved.endpoint).toBe("http://floci.test:4566");
      expect(resolved.region).toBe("eu-west-1");
    }),
  );

  it.effect(
    "rejects non-account-shaped local identities before any STS lookup",
    () =>
      localAwsCredentials({ method: "local", accountId: "worktree-a" }).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error.message).toContain("exactly 12 digits");
          }),
        ),
      ),
  );

  it.effect("resolves service overrides before the local endpoint", () =>
    Effect.gen(function* () {
      const endpoints = yield* Endpoint.ServiceEndpoint;
      expect((yield* endpoints).resolve("ses")).toBe(
        "http://samva-emulate.test/ses",
      );
      expect((yield* endpoints).resolve("sqs")).toBe("http://floci.test:4566");
    }).pipe(
      Effect.provide(AwsEndpoint.fromEnvironment),
      Effect.provideService(
        AWSEnvironment,
        Effect.succeed({
          accountId: "123456789012",
          region: "us-east-1",
          endpoint: "http://floci.test:4566",
          serviceEndpoints: { ses: "http://samva-emulate.test/ses" },
          credentials: Effect.die("not used"),
        }),
      ),
    ),
  );
});
