import {
  LambdaEnvironmentMaxBytes,
  lambdaEnvironmentSize,
  validateLambdaEnvironment,
} from "@alchemy.run/aws/Lambda/Function";
import { expect, it } from "@alchemy.run/test";
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
      JSON_TEXT: "false",
      NUMBER: 12,
    }),
  ).toBe(
    new TextEncoder().encode(
      JSON.stringify({
        ASCII: "value",
        UNICODE: "नमस्ते",
        SECRET: "hidden",
        JSON_TEXT: "false",
        NUMBER: "12",
      }),
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
      expect(result.failure.sizeBytes).toBeGreaterThan(LambdaEnvironmentMaxBytes);
      expect(result.failure.entryCount).toBe(1);
      expect(result.failure.message).not.toContain(secret);
      expect(result.failure.largestEntries[0]?.key).toBe("SECRET");
    }
  }),
);

it.effect("rejects an environment over a function's budget below the limit", () =>
  Effect.gen(function* () {
    const environment = { SMALL: "x", LARGE: "y".repeat(3_000) };
    yield* validateLambdaEnvironment(environment);
    const result = yield* Effect.result(validateLambdaEnvironment(environment, 2_048));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.limitBytes).toBe(2_048);
      expect(result.failure.largestEntries.map(({ key }) => key)).toEqual(["LARGE", "SMALL"]);
      expect(result.failure.message).toContain("budget is 2048 bytes");
    }
  }),
);

it.effect("refuses a budget above AWS's limit", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(validateLambdaEnvironment({}, LambdaEnvironmentMaxBytes + 1));
    expect(exit._tag).toBe("Failure");
  }),
);
