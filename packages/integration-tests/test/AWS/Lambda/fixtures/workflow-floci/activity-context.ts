import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, WorkflowEngine } from "effect/workflow";

class InlineService extends Context.Service<InlineService, { readonly value: string }>()(
  "InlineService",
) {}

export const ActivityContextResult = Schema.Struct({
  value: Schema.String,
  workflow: Schema.String,
  sameExecution: Schema.Boolean,
  isolated: Schema.Boolean,
  interrupted: Schema.Boolean,
  attempt: Schema.Number,
});

export const readInline = Effect.gen(function* () {
  const outer = yield* WorkflowEngine.WorkflowInstance;
  return yield* Activity.make({
    name: "read-inline",
    success: ActivityContextResult,
    execute: Effect.gen(function* () {
      const service = yield* InlineService;
      const instance = yield* WorkflowEngine.WorkflowInstance;
      yield* Effect.logInfo("inline activity body");
      return {
        value: service.value,
        workflow: instance.workflow._tag,
        sameExecution: instance.executionId === outer.executionId,
        isolated: instance !== outer,
        interrupted: instance.interrupted,
        attempt: yield* Activity.CurrentAttempt,
      };
    }),
  }).pipe(
    Effect.provideService(InlineService, { value: "present" }),
    Effect.annotateLogs({ inline: "present" }),
    Effect.withSpan("inline.callsite"),
  );
});
