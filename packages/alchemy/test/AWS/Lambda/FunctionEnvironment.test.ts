import {
  LambdaEnvironmentMaxBytes,
  lambdaEnvironmentSize,
  resolveFunctionEnvironment,
  resolveFunctionRuntimeEnv,
  validateLambdaEnvironment,
} from "@/AWS/Lambda/Function.ts";
import { ConfiguredServiceEndpoints } from "@/AWS/Endpoint.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

it.effect("serializes AWS runtime identity for packaged Lambdas", () =>
  resolveFunctionRuntimeEnv.pipe(
    Effect.tap((environment) =>
      Effect.sync(() => {
        expect(environment).toEqual({
          ALCHEMY_AWS_ACCOUNT_ID: "654654387918",
          ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify({
            ses: "http://emulate.samva:4300/ses",
            sesv2: "http://emulate.samva:4300/ses",
          }),
          ALCHEMY_STACK_NAME: "samva",
          ALCHEMY_STAGE: "production",
          ALCHEMY_PHASE: "runtime",
        });
      }),
    ),
    Effect.provideService(ConfiguredServiceEndpoints, {
      sesv2: "http://emulate.samva:4300/ses",
      ses: "http://emulate.samva:4300/ses",
    }),
    Effect.provideService(
      AWSEnvironment,
      Effect.succeed({
        accountId: "654654387918",
        region: "us-east-1",
        credentials: Effect.die("not used"),
      }),
    ),
    Effect.provideService(Stack, {
      name: "samva",
      stage: "production",
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
      {
        ALCHEMY_AWS_ACCOUNT_ID: "654654387918",
        ALCHEMY_STAGE: "production",
      },
    ),
  ).toEqual({
    ALCHEMY_AWS_ACCOUNT_ID: "654654387918",
    ALCHEMY_STAGE: "production",
  });
});

it("measures the serialized UTF-8 Lambda environment", () => {
  expect(
    lambdaEnvironmentSize({
      ASCII: "value",
      UNICODE: "नमस्ते",
      SECRET: Redacted.make("hidden"),
      OMITTED: undefined,
    }),
  ).toBe(
    new TextEncoder().encode(
      JSON.stringify({ ASCII: "value", UNICODE: "नमस्ते", SECRET: "hidden" }),
    ).byteLength,
  );
});

it.effect("accepts an environment within Lambda's aggregate limit", () =>
  validateLambdaEnvironment({ VALUE: "x" }),
);

it.effect("rejects an oversized environment without exposing values", () =>
  Effect.gen(function* () {
    const secret = "not-safe-to-log".repeat(300);
    const result = yield* Effect.result(
      validateLambdaEnvironment({ SECRET: Redacted.make(secret) }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("LambdaEnvironmentTooLarge");
      expect(result.failure.sizeBytes).toBeGreaterThan(
        LambdaEnvironmentMaxBytes,
      );
      expect(result.failure.entryCount).toBe(1);
      expect(result.failure.message).not.toContain(secret);
      expect(result.failure.largestEntries[0]?.key).toBe("SECRET");
    }
  }),
);
