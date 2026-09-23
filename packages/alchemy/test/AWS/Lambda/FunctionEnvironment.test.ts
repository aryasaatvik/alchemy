import {
  LambdaEnvironmentMaxBytes,
  lambdaEnvironmentSize,
  validateLambdaEnvironment,
} from "@/AWS/Lambda/Function.ts";
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
