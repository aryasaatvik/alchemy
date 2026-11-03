import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import { DurableDeferred } from "effect/workflow";
import { Approve, Approval } from "../../../Workflows/conformance/workflows.ts";

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
