import {
  applyEnvRegionOverride,
  localAwsCredentials,
} from "@/AWS/AuthProvider.ts";
import * as AwsEndpoint from "@/AWS/Endpoint.ts";
import {
  AWSEnvironment,
  Runtime as RuntimeAWSEnvironment,
} from "@/AWS/Environment.ts";
import { Credentials, Endpoint, Region } from "@distilled.cloud/aws";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

// Simulates credentials resolved from an SSO profile whose ~/.aws/config
// region differs from the region the user explicitly set in the environment.
const profileCreds = { accountId: "123456789012", region: "us-west-2" };

const runtimeAws = Layer.mergeAll(
  Layer.succeed(
    Credentials.Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("production-access-key"),
      secretAccessKey: Redacted.make("production-secret-key"),
      sessionToken: undefined,
      // `ResolvedCredentials` carries the region it authenticated against;
      // the explicit `Region` layer below is what actually dispatches.
      region: "us-east-1",
    }),
  ),
  Layer.succeed(Region.Region, Effect.succeed("ap-south-1")),
);

const withRuntimeEnvironment = (env: Record<string, string>) =>
  Effect.provide(
    RuntimeAWSEnvironment.pipe(
      Layer.provide(runtimeAws),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  );

describe("Lambda runtime AWS environment", () => {
  it.effect("reconstructs the global and service endpoint policy", () =>
    Effect.gen(function* () {
      const environment = yield* AWSEnvironment.current;
      const credentials = yield* environment.credentials;

      expect(environment.accountId).toBe("100000000004");
      expect(environment.region).toBe("ap-south-1");
      expect(environment.endpoint).toBe("http://floci:4566");
      expect(environment.serviceEndpoints).toEqual({
        ses: "http://emulate.samva:4300/ses",
        sesv2: "http://emulate.samva:4300/ses",
        servicequotas: "http://emulate.samva:4300/ses",
      });
      expect(Redacted.value(credentials.accessKeyId)).toBe(
        "production-access-key",
      );
      expect(Redacted.value(credentials.secretAccessKey)).toBe(
        "production-secret-key",
      );
    }).pipe(
      withRuntimeEnvironment({
        ALCHEMY_AWS_ACCOUNT_ID: "100000000004",
        AWS_ENDPOINT_URL: "http://floci:4566",
        ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify({
          ses: "http://emulate.samva:4300/ses",
          sesv2: "http://emulate.samva:4300/ses",
          servicequotas: "http://emulate.samva:4300/ses",
        }),
      }),
    ),
  );

  it.effect(
    "keeps production endpoint-free without replacing credentials",
    () =>
      Effect.gen(function* () {
        const environment = yield* AWSEnvironment.current;
        const credentials = yield* environment.credentials;

        expect(environment.endpoint).toBeUndefined();
        expect(environment.serviceEndpoints).toBeUndefined();
        expect(Redacted.value(credentials.accessKeyId)).toBe(
          "production-access-key",
        );
        expect(Redacted.value(credentials.secretAccessKey)).toBe(
          "production-secret-key",
        );
      }).pipe(
        withRuntimeEnvironment({
          ALCHEMY_AWS_ACCOUNT_ID: "654654387918",
        }),
      ),
  );
});

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
  it.effect(
    "uses the selected account and explicit fallback when credentials are absent",
    () =>
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
        expect(Redacted.value(credentials.secretAccessKey)).toBe(
          "alchemy-local-emulator",
        );
        expect(credentials.sessionToken).toBeUndefined();
        expect(resolved.endpoint).toBe("http://floci.test:4566");
        expect(resolved.region).toBe("eu-west-1");
      }).pipe(withEnv({})),
  );

  it.effect(
    "preserves the exact configured credential tuple used by the local Lambda runtime",
    () =>
      Effect.gen(function* () {
        const resolved = yield* localAwsCredentials({
          method: "local",
          accountId: "100000000004",
          endpoint: "http://floci.test:4566",
        });
        const credentials = yield* resolved.credentials;

        expect(resolved.accountId).toBe("100000000004");
        expect(Redacted.value(credentials.accessKeyId)).toBe("100000000004");
        expect(Redacted.value(credentials.secretAccessKey)).toBe(
          "samva-local-floci",
        );
        expect(Redacted.value(credentials.sessionToken!)).toBe(
          "samva-local-session",
        );
      }).pipe(
        withEnv({
          AWS_ACCESS_KEY_ID: "100000000004",
          AWS_SECRET_ACCESS_KEY: "samva-local-floci",
          AWS_SESSION_TOKEN: "samva-local-session",
        }),
      ),
  );

  it.effect("rejects every partial local credential tuple", () =>
    Effect.gen(function* () {
      for (const env of [
        { AWS_ACCESS_KEY_ID: "100000000004" },
        { AWS_SECRET_ACCESS_KEY: "samva-local-floci" },
        { AWS_SESSION_TOKEN: "samva-local-session" },
        {
          AWS_ACCESS_KEY_ID: "100000000004",
          AWS_SESSION_TOKEN: "samva-local-session",
        },
      ]) {
        const error = yield* localAwsCredentials({
          method: "local",
          accountId: "100000000004",
        }).pipe(withEnv(env), Effect.flip);
        expect(error.message).toBe(
          "Local AWS credentials must set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY together; AWS_SESSION_TOKEN requires both.",
        );
      }
    }),
  );

  it.effect(
    "rejects non-account-shaped local identities before any STS lookup",
    () =>
      localAwsCredentials({ method: "local", accountId: "worktree-a" }).pipe(
        withEnv({}),
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
      expect(endpoints.resolve("ses")).toBe("http://samva-emulate.test/ses");
      expect(endpoints.resolve("sqs")).toBe("http://floci.test:4566");
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

describe("stack endpoint policy", () => {
  it.effect("routes the Samva SES operations before the Floci fallback", () =>
    Effect.gen(function* () {
      const endpoints = yield* Endpoint.ServiceEndpoint;

      // SES v1 DescribeReceiptRuleSet, SES v2 GetConfigurationSet, and
      // Service Quotas operations use these three SigV4 service names.
      expect(endpoints.resolve("ses")).toBe("http://samva-emulate.test/ses");
      expect(endpoints.resolve("sesv2")).toBe("http://samva-emulate.test/ses");
      expect(endpoints.resolve("servicequotas")).toBe(
        "http://samva-emulate.test/ses",
      );
      expect(endpoints.resolve("sqs")).toBe("http://floci.test:4566");
      expect(yield* Endpoint.resolve("sqs")).toBe("http://floci.test:4566");
      expect(
        yield* Endpoint.resolve("ses").pipe(
          Effect.provide(AwsEndpoint.of("http://operation.test")),
        ),
      ).toBe("http://operation.test");
    }).pipe(
      Effect.provide(
        AwsEndpoint.fromEnvironmentWithServiceEndpoints(
          Effect.succeed({
            ses: "http://samva-emulate.test/ses",
            sesv2: "http://samva-emulate.test/ses",
            servicequotas: "http://samva-emulate.test/ses",
          }),
        ),
      ),
      Effect.provideService(
        AWSEnvironment,
        Effect.succeed({
          accountId: "123456789012",
          region: "us-east-1",
          endpoint: "http://floci.test:4566",
          credentials: Effect.die("not used"),
        }),
      ),
    ),
  );
});
