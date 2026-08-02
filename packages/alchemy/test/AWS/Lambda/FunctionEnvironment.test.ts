import {
  LambdaEnvironmentMaxBytes,
  lambdaEnvironmentSize,
  materializeLambdaEnvironment,
  mergeFunctionEnvironment,
  resolveFunctionEnvironment,
  validateLambdaEnvironment,
} from "@/AWS/Lambda/Function.ts";
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
});
