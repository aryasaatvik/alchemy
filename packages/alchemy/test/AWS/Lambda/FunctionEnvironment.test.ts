import {
  LambdaEnvironmentMaxBytes,
  lambdaEnvironmentSize,
  materializeLambdaEnvironment,
  mergeFunctionEnvironment,
  resolveFunctionEnvironment,
  validateLambdaEnvironment,
} from "@/AWS/Lambda/Function.ts";
import { packEnvValue } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

describe("Lambda environment size", () => {
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
