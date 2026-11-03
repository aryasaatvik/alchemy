import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Workflow, DurableDeferred } from "effect/workflow";
import { Approval } from "../../../Workflows/conformance/workflows.ts";

export const Approve = Workflow.make("Approve", {
  payload: { id: Schema.String, note: Schema.optional(Schema.String) },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

export class TestWorkflows extends Lambda.WorkflowFunction<TestWorkflows>()("TestWorkflows", {
  workflows: [Approve],
}) {}

export const liveAlias = Effect.gen(function* () {
  const fn = yield* TestWorkflows;
  const version = yield* Lambda.Version("WorkflowsVersion", { function: fn });
  return yield* Lambda.Alias("WorkflowsLive", { version, aliasName: "live" });
});

export default TestWorkflows.make(
  { main: import.meta.url },
  Workflows.layer(Approve, () => DurableDeferred.await(Approval)),
);
