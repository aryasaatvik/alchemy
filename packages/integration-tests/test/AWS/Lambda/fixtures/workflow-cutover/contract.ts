import * as Workflows from "alchemy/Workflows";
import { Effect, Exit, Schema } from "effect";
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";

export class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  reason: Schema.String,
}) {}
export const Approval = DurableDeferred.make("approval", {
  success: Schema.String,
  error: Rejected,
});
export const Future = DurableDeferred.make("future", { success: Schema.String });
export const Probe = Workflow.make("CutoverProbe", {
  payload: { id: Schema.String, suspend: Schema.Boolean },
  success: Schema.String,
  error: Rejected,
  idempotencyKey: ({ id }) => id,
});

const runtimeIdentity = () =>
  `${process.env.CUTOVER_BUILD}:${process.env.AWS_LAMBDA_FUNCTION_VERSION}`;

export const live = Workflows.layer(Probe, ({ suspend }) => {
  if (suspend) {
    return Activity.make({
      name: "hold",
      success: Schema.String,
      execute: Effect.flatMap(WorkflowEngine.WorkflowInstance, Workflow.suspend),
    });
  }
  return DurableDeferred.await(Approval).pipe(
    Effect.map((value) => `${value}:${runtimeIdentity()}`),
    Effect.mapError((error) => new Rejected({ reason: `${error.reason}:${runtimeIdentity()}` })),
  );
});

export const completion = {
  success: Exit.succeed("approved"),
  failure: Exit.fail(new Rejected({ reason: "rejected" })),
};
