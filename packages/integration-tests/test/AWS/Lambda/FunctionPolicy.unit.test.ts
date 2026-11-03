import { expect, test } from "bun:test";
import type { PolicyStatement } from "@alchemy.run/aws/IAM/Policy";
import {
  compactFunctionPolicy,
  renderFunctionPolicy,
  functionLogGroupGuard,
  LambdaRolePolicyMaxBytes,
} from "@alchemy.run/aws/Lambda/FunctionPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { apiPolicyStatements } from "./fixtures/function-policy.ts";

const grant = (
  Action: string[],
  Resource: string[],
  extra: Partial<PolicyStatement> = {},
): PolicyStatement => ({ Effect: "Allow", Action, Resource, ...extra });
const guard = functionLogGroupGuard("us-east-1", "100000002303", "samva-Api-local-e2e-test");
const pairs = (statements: PolicyStatement[]) =>
  [
    ...new Set(
      statements.flatMap((s) =>
        (s.Action ?? []).flatMap((a) =>
          (typeof s.Resource === "string" ? [s.Resource] : (s.Resource ?? [])).map((r) =>
            JSON.stringify([s.Effect, a, r, s.Condition ?? null]),
          ),
        ),
      ),
    ),
  ].sort();

test("removes exact duplicates and normalizes action/resource sets", () => {
  const a = grant(["s3:GetObject", "s3:ListBucket"], ["bucket", "object"]);
  expect(
    compactFunctionPolicy([
      a,
      a,
      grant(["s3:ListBucket", "s3:GetObject", "s3:GetObject"], ["object", "bucket"]),
    ]),
  ).toHaveLength(1);
});
test("unions resources for equal actions then actions for equal resources", () => {
  expect(
    compactFunctionPolicy([
      grant(["read"], ["a"]),
      grant(["read"], ["b"]),
      grant(["write"], ["b", "a"]),
    ]),
  ).toEqual([grant(["read", "write"], ["a", "b"])]);
});
test("preserves every permission pair without Cartesian-product widening", () => {
  const original = [
    grant(["read"], ["a"]),
    grant(["write"], ["b"]),
    grant(["read"], ["c"]),
    grant(["read"], ["a"], { Effect: "Deny" }),
    grant(["read"], ["a"], { Condition: { StringEquals: { tenant: "one" } } }),
    grant(["read"], ["a"], { Condition: { StringEquals: { tenant: "two" } } }),
  ];
  const compacted = compactFunctionPolicy(original);
  expect(pairs(compacted)).toEqual(pairs(original));
  expect(
    compacted.some((s) => s.Action?.includes("*") || (s.Resource as string[]).includes("*")),
  ).toBe(false);
});
test("does not merge across principals or negative selectors", () => {
  const original = [
    grant(["read"], ["a"], { Principal: "one" }),
    grant(["read"], ["b"], { Principal: "two" }),
    grant(["read"], ["a"], { NotAction: ["delete"] }),
    grant(["read"], ["a"], { NotResource: ["hidden"] }),
    { Effect: "Allow" as const, Action: ["read"] },
  ];
  expect(compactFunctionPolicy(original)).toHaveLength(5);
});
test("canonical ordering is independent of registration and object key order", () => {
  const original = [
    grant(["write"], ["b"], { Sid: "Second-Sid", Condition: { StringEquals: { z: "z", a: "a" } } }),
    grant(["read"], ["a"]),
    grant(["write"], ["a"], { Sid: "FirstSid", Condition: { StringEquals: { a: "a", z: "z" } } }),
  ];
  const before = JSON.stringify(original);
  expect(JSON.stringify(compactFunctionPolicy(original))).toBe(
    JSON.stringify(compactFunctionPolicy([...original].reverse())),
  );
  expect(JSON.stringify(original)).toBe(before);
});
for (const variant of ["base", "pr4"] as const)
  test(`${variant} API-shaped binding set fits after compaction`, async () => {
    const statements = apiPolicyStatements(variant);
    expect(statements).toHaveLength(variant === "base" ? 45 : 46);
    expect(new Set(statements.map((s) => JSON.stringify(s))).size).toBe(statements.length - 8);
    const before = new TextEncoder().encode(
      JSON.stringify({ Version: "2012-10-17", Statement: statements }) + guard,
    ).byteLength;
    const rendered = await Effect.runPromise(
      renderFunctionPolicy("samva-Api-test", statements, guard),
    );
    expect(before).toBeGreaterThan(LambdaRolePolicyMaxBytes);
    expect(rendered.sizeBytes).toBeLessThanOrEqual(LambdaRolePolicyMaxBytes);
    expect(pairs(JSON.parse(rendered.document!).Statement)).toEqual(pairs(statements));
    expect(rendered.document).toBe(JSON.stringify(JSON.parse(rendered.document!)));
    console.log(
      "SYNTHETIC_POLICY_BYTES",
      JSON.stringify({ variant, statements: statements.length, before, after: rendered.sizeBytes }),
    );
  });
test("rejects aggregate size including the log guard and names the role", async () => {
  const statement = grant(["read"], ["x".repeat(10100)]);
  const result = await Effect.runPromise(
    Effect.result(renderFunctionPolicy("samva-Api-too-large", [statement], guard)),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure.roleName).toBe("samva-Api-too-large");
    expect(result.failure.sizeBytes).toBeGreaterThan(10240);
    expect(result.failure.message).toContain(String(result.failure.sizeBytes));
    expect(result.failure.message).toContain("managed-policy split");
  }
});

test("accepts exactly the byte budget and rejects one byte more", async () => {
  const overhead = (
    await Effect.runPromise(renderFunctionPolicy("boundary", [grant(["read"], [""])], guard))
  ).sizeBytes;
  const resource = "x".repeat(LambdaRolePolicyMaxBytes - overhead);
  expect(
    (
      await Effect.runPromise(
        renderFunctionPolicy("boundary", [grant(["read"], [resource])], guard),
      )
    ).sizeBytes,
  ).toBe(LambdaRolePolicyMaxBytes);
  expect(
    Result.isFailure(
      await Effect.runPromise(
        Effect.result(renderFunctionPolicy("boundary", [grant(["read"], [resource + "x"])], guard)),
      ),
    ),
  ).toBe(true);
});

test("preserves every action/resource pair over all three-by-three grant matrices", () => {
  for (let mask = 1; mask < 512; mask++) {
    const original: PolicyStatement[] = [];
    for (let cell = 0; cell < 9; cell++)
      if (mask & (1 << cell))
        original.push(grant([`action-${Math.floor(cell / 3)}`], [`resource-${cell % 3}`]));
    expect(pairs(compactFunctionPolicy(original))).toEqual(pairs(original));
  }
});
