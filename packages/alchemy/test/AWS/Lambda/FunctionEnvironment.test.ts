import {
  LambdaEnvironmentMaxBytes,
  lambdaEnvironmentSize,
  materializeLambdaEnvironment,
  mergeFunctionEnvironment,
  resolveFunctionEnvironment,
  resolveFunctionRuntimeEnv,
  validateLambdaEnvironment,
} from "@/AWS/Lambda/Function.ts";
import { localEmulatorFunctionEnvironment } from "@/AWS/Lambda/FunctionProvider.ts";
import * as AwsEndpoint from "@/AWS/Endpoint.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { packEnvValue, unpackEnvValue } from "@/RuntimeContext.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { fromEnv } from "@aws-sdk/credential-providers";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

describe("Lambda environment size", () => {
  it.effect("serializes provider service endpoints into runtime identity", () =>
    resolveFunctionRuntimeEnv.pipe(
      Effect.tap((environment) =>
        Effect.sync(() => {
          expect(environment).toEqual({
            ALCHEMY_AWS_ACCOUNT_ID: "100000000004",
            ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify({
              servicequotas: "http://emulate.samva:4300/ses",
              ses: "http://emulate.samva:4300/ses",
              sesv2: "http://emulate.samva:4300/ses",
            }),
            ALCHEMY_STACK_NAME: "samva",
            ALCHEMY_STAGE: "dev-saatvik",
          });
        }),
      ),
      Effect.provide(
        AwsEndpoint.fromEnvironmentWithServiceEndpoints(
          Effect.succeed({
            servicequotas: "http://emulate.samva:4300/ses",
            sesv2: "http://emulate.samva:4300/ses",
            ses: "http://emulate.samva:4300/ses",
          }),
        ),
      ),
      Effect.provideService(
        AWSEnvironment,
        Effect.succeed({
          accountId: "100000000004",
          region: "ap-south-1",
          credentials: Effect.die("not used"),
        }),
      ),
      Effect.provideService(Stack, {
        name: "samva",
        stage: "dev-saatvik",
        resources: {},
        bindings: {},
        actions: {},
      } satisfies Omit<StackSpec, "output">),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    ),
  );

  it("always includes Alchemy runtime identity", () => {
    expect(
      resolveFunctionEnvironment(
        undefined,
        {
          main: "handler.ts",
          build: { output: { sourcemap: false } },
          uploadSourceMap: false,
        },
        { ALCHEMY_STAGE: "test" },
      ),
    ).toEqual({ ALCHEMY_STAGE: "test" });
  });

  it("measures the final env after binding, Function, and Alchemy precedence", () => {
    const props = {
      main: "handler.ts",
      build: { output: { sourcemap: false } },
      uploadSourceMap: false,
      env: {
        FROM_FUNCTION: "function",
        SHARED: "function",
        ALCHEMY_STAGE: "must-not-win",
      },
    };
    const environment = resolveFunctionEnvironment(
      mergeFunctionEnvironment(
        { FROM_BINDING: "binding", SHARED: "binding" },
        props,
      ),
      props,
      { ALCHEMY_STAGE: "test" },
    );

    expect(environment).toEqual({
      FROM_BINDING: "binding",
      FROM_FUNCTION: "function",
      SHARED: "function",
      ALCHEMY_STAGE: "test",
    });
  });

  it.effect(
    "keeps emulator endpoints and configured credentials authoritative",
    () =>
      Effect.gen(function* () {
        const hostEndpoint = packEnvValue(
          Redacted.make("http://127.0.0.1:4566"),
        );
        const serviceEndpoint = packEnvValue(
          Redacted.make("http://host.docker.internal:4300/ses"),
        );
        const resolved = resolveFunctionEnvironment(
          {
            AWS_ENDPOINT_URL: hostEndpoint,
            AWS_ACCESS_KEY_ID: packEnvValue(Redacted.make("100000000004")),
            AWS_SECRET_ACCESS_KEY: packEnvValue(
              Redacted.make("samva-local-floci"),
            ),
            AWS_SESSION_TOKEN: packEnvValue(Redacted.make("session")),
            SES_ENDPOINT_URL: serviceEndpoint,
          },
          {
            main: "handler.ts",
            build: { output: { sourcemap: false } },
            uploadSourceMap: false,
          },
          { ALCHEMY_STAGE: "test" },
        );

        // The ordinary provider retains the configured values. Only the local
        // emulator provider removes the host endpoint and reifies the standard
        // credential tuple before Floci appends application entries.
        expect(resolved.AWS_ENDPOINT_URL).toBe(hostEndpoint);
        const appEnvironment =
          yield* localEmulatorFunctionEnvironment(resolved);
        expect(appEnvironment).not.toHaveProperty("AWS_ENDPOINT_URL");
        expect(appEnvironment.AWS_ACCESS_KEY_ID).toBe("100000000004");
        expect(appEnvironment.AWS_SECRET_ACCESS_KEY).toBe("samva-local-floci");
        expect(appEnvironment.AWS_SESSION_TOKEN).toBe("session");
        expect(appEnvironment.SES_ENDPOINT_URL).toBe(serviceEndpoint);

        const containerEnvironment = Object.fromEntries([
          ["AWS_ENDPOINT_URL", "http://floci:4566"],
          ["AWS_ACCESS_KEY_ID", "test"],
          ["AWS_SECRET_ACCESS_KEY", "test"],
          ...Object.entries(appEnvironment),
        ]);
        expect(containerEnvironment).toEqual({
          AWS_ENDPOINT_URL: "http://floci:4566",
          AWS_ACCESS_KEY_ID: "100000000004",
          AWS_SECRET_ACCESS_KEY: "samva-local-floci",
          AWS_SESSION_TOKEN: "session",
          SES_ENDPOINT_URL: serviceEndpoint,
          ALCHEMY_STAGE: "test",
        });
        expect(unpackEnvValue(containerEnvironment.AWS_ENDPOINT_URL)).toBe(
          "http://floci:4566",
        );
      }),
  );

  it.effect(
    "uses placement-specific service endpoints only in the local Lambda environment",
    () =>
      Effect.gen(function* () {
        const canonical = JSON.stringify({
          ses: "https://worktree.emulate.samva.localhost/ses",
          sesv2: "https://worktree.emulate.samva.localhost/ses",
        });
        const environment = {
          ALCHEMY_AWS_SERVICE_ENDPOINTS: canonical,
          ALCHEMY_STAGE: "test",
        };
        const transformed = yield* localEmulatorFunctionEnvironment(
          environment,
          {
            serviceEndpoints: Effect.succeed({
              sesv2: "http://host.docker.internal:4300/ses",
              servicequotas: "http://host.docker.internal:4300/ses",
              ses: "http://host.docker.internal:4300/ses",
            }),
          },
        );

        expect(environment.ALCHEMY_AWS_SERVICE_ENDPOINTS).toBe(canonical);
        expect(transformed.ALCHEMY_AWS_SERVICE_ENDPOINTS).toBe(
          JSON.stringify({
            servicequotas: "http://host.docker.internal:4300/ses",
            ses: "http://host.docker.internal:4300/ses",
            sesv2: "http://host.docker.internal:4300/ses",
          }),
        );
      }),
  );

  it.effect("removes an explicitly empty local Lambda service map", () =>
    Effect.gen(function* () {
      const transformed = yield* localEmulatorFunctionEnvironment(
        {
          ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify({
            ses: "https://worktree.emulate.samva.localhost/ses",
          }),
        },
        { serviceEndpoints: Effect.succeed({}) },
      );

      expect(transformed).not.toHaveProperty("ALCHEMY_AWS_SERVICE_ENDPOINTS");
    }),
  );

  it.effect("rejects malformed local Lambda service maps", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        localEmulatorFunctionEnvironment(
          {
            ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify({
              ses: "https://worktree.emulate.samva.localhost/ses",
            }),
          },
          {
            serviceEndpoints: Effect.succeed({ ses: "" }),
          },
        ),
      );

      expect(error._tag).toBe("LocalEmulatorFunctionEnvironmentError");
      expect(error.message).not.toContain("worktree.emulate.samva.localhost");
    }),
  );

  it.effect("reifies legacy and raw local credential tuples", () =>
    Effect.gen(function* () {
      const legacy = yield* localEmulatorFunctionEnvironment({
        AWS_ACCESS_KEY_ID:
          'alchemy:env:v1:{"_tag":"Redacted","value":"100000000004"}',
        AWS_SECRET_ACCESS_KEY:
          'alchemy:env:v1:{"_tag":"Redacted","value":"samva-local-floci"}',
      });
      expect(legacy).toEqual({
        AWS_ACCESS_KEY_ID: "100000000004",
        AWS_SECRET_ACCESS_KEY: "samva-local-floci",
      });

      const raw = yield* localEmulatorFunctionEnvironment({
        AWS_ACCESS_KEY_ID: "100000000004",
        AWS_SECRET_ACCESS_KEY: "samva-local-floci",
        AWS_SESSION_TOKEN: "session",
      });
      expect(raw).toEqual({
        AWS_ACCESS_KEY_ID: "100000000004",
        AWS_SECRET_ACCESS_KEY: "samva-local-floci",
        AWS_SESSION_TOKEN: "session",
      });
    }),
  );

  it.effect(
    "rejects partial, malformed, and non-string credential tuples",
    () =>
      Effect.gen(function* () {
        const invalidEnvironments = [
          { AWS_ACCESS_KEY_ID: packEnvValue(Redacted.make("access-only")) },
          {
            AWS_SECRET_ACCESS_KEY: packEnvValue(Redacted.make("secret-only")),
          },
          { AWS_SESSION_TOKEN: packEnvValue(Redacted.make("token-only")) },
          {
            AWS_ACCESS_KEY_ID: packEnvValue(42),
            AWS_SECRET_ACCESS_KEY: packEnvValue(
              Redacted.make("must-not-appear"),
            ),
          },
          {
            AWS_ACCESS_KEY_ID: "~1j{",
            AWS_SECRET_ACCESS_KEY: packEnvValue(
              Redacted.make("must-not-appear"),
            ),
          },
          {
            AWS_ACCESS_KEY_ID: 42,
            AWS_SECRET_ACCESS_KEY: packEnvValue(
              Redacted.make("must-not-appear"),
            ),
          },
        ];

        for (const environment of invalidEnvironments) {
          const error = yield* Effect.flip(
            localEmulatorFunctionEnvironment(environment),
          );
          expect(error._tag).toBe("LocalEmulatorFunctionEnvironmentError");
          expect(error.message).not.toContain("must-not-appear");
        }
      }),
  );

  it.effect("provides the configured account to the AWS SDK env provider", () =>
    Effect.gen(function* () {
      const transformed = yield* localEmulatorFunctionEnvironment({
        AWS_ACCESS_KEY_ID: packEnvValue(Redacted.make("100000000004")),
        AWS_SECRET_ACCESS_KEY: packEnvValue(Redacted.make("samva-local-floci")),
        AWS_SESSION_TOKEN: packEnvValue(Redacted.make("session")),
      });
      const keys = [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
      ] as const;

      const credentials = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = Object.fromEntries(
            keys.map((key) => [key, process.env[key]]),
          );
          for (const key of keys) {
            process.env[key] = transformed[key];
          }
          return previous;
        }),
        () => Effect.tryPromise(() => fromEnv()()),
        (previous) =>
          Effect.sync(() => {
            for (const key of keys) {
              const value = previous[key];
              if (value === undefined) {
                delete process.env[key];
              } else {
                process.env[key] = value;
              }
            }
          }),
      );

      expect(credentials).toEqual({
        accessKeyId: "100000000004",
        secretAccessKey: "samva-local-floci",
        sessionToken: "session",
        $source: { CREDENTIALS_ENV_VARS: "g" },
      });
    }),
  );

  it("accepts exactly 4 KiB and rejects the next byte", () => {
    // `{"AA":""}` contributes nine bytes around the value.
    const atLimit = { AA: "x".repeat(LambdaEnvironmentMaxBytes - 9) };
    expect(lambdaEnvironmentSize(atLimit)).toBe(LambdaEnvironmentMaxBytes);
    expect(Effect.runSync(validateLambdaEnvironment(atLimit))).toBeUndefined();

    const overLimit = { AA: `${atLimit.AA}x` };
    const error = Effect.runSync(
      Effect.flip(validateLambdaEnvironment(overLimit)),
    );
    expect(error._tag).toBe("LambdaEnvironmentTooLarge");
    expect(error.sizeBytes).toBe(LambdaEnvironmentMaxBytes + 1);
    expect(error.limitBytes).toBe(LambdaEnvironmentMaxBytes);
    expect(error.largestEntries).toEqual([
      { key: "AA", bytes: LambdaEnvironmentMaxBytes - 1 },
    ]);
  });

  it("counts UTF-8 bytes and never includes a redacted value in diagnostics", () => {
    const secret = "é".repeat(LambdaEnvironmentMaxBytes);
    const environment = { SECRET: Redacted.make(secret) };
    const error = Effect.runSync(
      Effect.flip(validateLambdaEnvironment(environment)),
    );

    expect(error.sizeBytes).toBeGreaterThan(LambdaEnvironmentMaxBytes);
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("SECRET");
    expect(error.largestEntries[0]?.key).toBe("SECRET");
  });

  it("materializes redacted values for a Live child without preserving wrappers", () => {
    expect(
      materializeLambdaEnvironment({
        PLAIN: "value",
        SECRET: Redacted.make("secret"),
        OMITTED: undefined,
      }),
    ).toEqual({ PLAIN: "value", SECRET: "secret" });
  });

  it("keeps the measured Samva environment comfortably below the AWS limit", () => {
    const boundKeys = [
      "DATABASE_URL",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "BETTER_AUTH_SECRET",
      "AUTUMN_SECRET_KEY",
      "AUTUMN_WEBHOOK_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "TURNSTILE_SECRET_KEY",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_VERIFY_TOKEN",
      "META_APP_ID",
      "META_APP_SECRET",
      "TELNYX_MASTER_API_KEY",
      "TELNYX_PUBLIC_KEY",
      "TWILIO_MASTER_ACCOUNT_SID",
      "TWILIO_MASTER_AUTH_TOKEN",
      "SAMVA_CLOUDFLARE_ACCOUNT_ID",
      "SAMVA_CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_R2_ACCESS_KEY_ID",
      "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
      "CLOUDFLARE_R2_ENDPOINT_URL",
      "ASSETS_BUCKET",
      "SAMVA_EMAIL_ZONE_ID",
      "SAMVA_SH_ZONE_ID",
      "SAMVA_CLOUDFLARE_ZONE_ID",
      "DOMAIN_CONNECT_SIGNING_KEY",
      "SES_FROM_EMAIL",
      "SES_FROM_NAME",
      "SES_ENDPOINT_URL",
      "FORWARDING_EMAIL",
      "SAMVA_EMAIL_BASE_DOMAIN",
      "VITE_PUBLIC_WEB_URL",
      "VITE_PUBLIC_API_URL",
      "MCP_RESOURCE_URL",
      "AXIOM_TOKEN",
      "AXIOM_EVENTS_DATASET",
      "AXIOM_TRACES_DATASET",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "FLAGSHIP_APP_ID",
      "SMTP_INTERNAL_TOKEN",
    ] as const;
    const bound = Object.fromEntries(
      boundKeys.map((key, index) => [
        key,
        Redacted.make("x".repeat(index === 0 ? 579 : 10)),
      ]),
    );
    const runtime = {
      ALCHEMY_STAGE: "production",
      AWS_REGION: "us-east-1",
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-handler",
      AWS_LAMBDA_LOG_FORMAT: "JSON",
      NODE_OPTIONS: "--enable-source-maps",
      NODE_ENV: "production",
    };
    const packBindings = (pack: (value: Redacted.Redacted<string>) => string) =>
      Object.fromEntries(
        Object.entries(bound).map(([key, value]) => [key, pack(value)]),
      );
    const previousWire = {
      ...packBindings(
        (value) =>
          `alchemy:env:v1:${JSON.stringify({
            _tag: "Redacted",
            value: Redacted.value(value),
          })}`,
      ),
      ...runtime,
    };
    const compactWire = {
      ...packBindings(packEnvValue),
      ...runtime,
    };

    expect(Object.keys(compactWire)).toHaveLength(49);
    expect(lambdaEnvironmentSize(previousWire)).toBe(4_572);
    expect(lambdaEnvironmentSize(compactWire)).toBe(2_422);
    expect(LambdaEnvironmentMaxBytes - lambdaEnvironmentSize(compactWire)).toBe(
      1_674,
    );
  });
});
