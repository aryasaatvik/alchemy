import { AWSEnvironment } from "@/AWS/Environment.ts";
import {
  LambdaEnvironmentMaxBytes,
  lambdaEnvironmentSize,
  resolveFunctionRuntimeEnv,
  validateLambdaEnvironment,
} from "@/AWS/Lambda/Function.ts";
import {
  CloudflareEnvironment,
  runtimeIdentity,
} from "@/Cloudflare/CloudflareEnvironment.ts";
import { Stack } from "@/Stack.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

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

it.effect(
  "rejects an environment over a function's budget below the limit",
  () =>
    Effect.gen(function* () {
      const environment = { SMALL: "x", LARGE: "y".repeat(3_000) };
      yield* validateLambdaEnvironment(environment);
      const result = yield* Effect.result(
        validateLambdaEnvironment(environment, 2_048),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.limitBytes).toBe(2_048);
        expect(result.failure.largestEntries.map(({ key }) => key)).toEqual([
          "LARGE",
          "SMALL",
        ]);
        expect(result.failure.message).toContain("budget is 2048 bytes");
      }
    }),
);

it.effect("refuses a budget above AWS's limit", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      validateLambdaEnvironment({}, LambdaEnvironmentMaxBytes + 1),
    );
    expect(exit._tag).toBe("Failure");
  }),
);

const provideDeployIdentity = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
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
    }),
  );

it.effect("serializes the runtime identity of a packaged Lambda", () =>
  Effect.gen(function* () {
    expect(yield* resolveFunctionRuntimeEnv).toEqual({
      ALCHEMY_STACK_NAME: "samva",
      ALCHEMY_STAGE: "production",
      ALCHEMY_PHASE: "runtime",
      ALCHEMY_AWS_ACCOUNT_ID: "654654387918",
    });
  }).pipe(provideDeployIdentity),
);

it.effect("carries the deploying stack's Cloudflare account", () =>
  Effect.gen(function* () {
    const environment = yield* resolveFunctionRuntimeEnv;
    expect(environment.ALCHEMY_CLOUDFLARE_ACCOUNT_ID).toBe("cf-account");
  }).pipe(
    provideDeployIdentity,
    Effect.provideService(
      CloudflareEnvironment,
      Effect.succeed(runtimeIdentity("cf-account")),
    ),
  ),
);

it.effect("omits an unresolvable Cloudflare account instead of failing", () =>
  Effect.gen(function* () {
    const environment = yield* resolveFunctionRuntimeEnv;
    expect(environment).not.toHaveProperty("ALCHEMY_CLOUDFLARE_ACCOUNT_ID");
  }).pipe(
    provideDeployIdentity,
    Effect.provideService(
      CloudflareEnvironment,
      Effect.die(new Error("Cloudflare is not configured")),
    ),
  ),
);
