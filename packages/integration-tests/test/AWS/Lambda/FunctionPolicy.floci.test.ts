import * as Lambda from "@alchemy.run/aws/Lambda";
import { compactFunctionPolicy } from "@alchemy.run/aws/Lambda/FunctionPolicy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { apiPolicyStatements } from "./fixtures/function-policy.ts";
import { testOptions } from "./fixtures/workflow-floci/test-options.ts";

class PolicyFunction extends Lambda.Function<PolicyFunction>()("PolicyFunction") {}
const { test } = Test.make(testOptions);
const program = (variant: "base" | "pr4") =>
  PolicyFunction.pipe(
    Effect.provide(
      PolicyFunction.make(
        { main: new URL("./async-handler.ts", import.meta.url).pathname },
        Effect.gen(function* () {
          const host = yield* Lambda.Function;
          const statements = apiPolicyStatements(variant);
          // Spread the grant set over independent bindings, as real capability layers do.
          for (let index = 0; index < 31; index++)
            yield* host.bind`policy-${index}`({
              policyStatements: statements.filter((_, i) => i % 31 === index),
            });
          return {};
        }),
      ),
    ),
  );

test.provider.skipIf(!process.env.WORKFLOW_FLOCI_ENDPOINT)(
  "Lambda policy parity: compact base and PR4 grants survive plan, create and update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      for (const variant of ["base", "pr4"] as const) {
        yield* stack.plan(program(variant));
        const output = yield* stack.deploy(program(variant));
        const names = yield* iam.listRolePolicies
          .items({ RoleName: output.roleName })
          .pipe(Stream.runCollect);
        let bytes = 0;
        let bindingPolicy: object | undefined;
        let guardBytes = 0;
        for (const name of names) {
          const policy = yield* iam.getRolePolicy({ RoleName: output.roleName, PolicyName: name });
          const document = decodeURIComponent(policy.PolicyDocument);
          bytes += new TextEncoder().encode(document).byteLength;
          if (name !== "AlchemyDenyLogGroupCreate") bindingPolicy = JSON.parse(document);
          else guardBytes = new TextEncoder().encode(document).byteLength;
        }
        expect(bindingPolicy).toEqual({
          Version: "2012-10-17",
          Statement: compactFunctionPolicy(apiPolicyStatements(variant)),
        });
        expect(bytes).toBeLessThanOrEqual(10240);
        expect(names.length).toBe(2);
        console.log(
          "FLOCI_POLICY_BYTES",
          JSON.stringify({
            variant,
            before:
              new TextEncoder().encode(
                JSON.stringify({ Version: "2012-10-17", Statement: apiPolicyStatements(variant) }),
              ).byteLength + guardBytes,
            after: bytes,
          }),
        );
      }
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
