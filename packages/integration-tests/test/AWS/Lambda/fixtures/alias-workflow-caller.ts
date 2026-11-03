import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { WorkflowEngine } from "effect/workflow";
import { Approval } from "../../../Workflows/conformance/workflows.ts";
import { Approve, TestWorkflows, liveAlias } from "./alias-workflow-host.ts";

export class AliasWorkflowCaller extends Lambda.Function<AliasWorkflowCaller>()(
  "AliasWorkflowCaller",
) {}
export default AliasWorkflowCaller.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const client = yield* Workflows.RunWorkflow(Approve);
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const host = yield* Lambda.Function;
    yield* host.listen((event: { operation: string; note?: string }) =>
      Effect.gen(function* () {
        const executionId = yield* Approve.executionId({ id: "execution", note: event.note });
        const run = client.get(executionId);
        switch (event.operation) {
          case "start":
            return yield* client
              .start({ id: "execution", note: event.note })
              .pipe(Effect.map((r) => r.executionRef));
          case "status":
            return yield* run.status;
          case "success":
            return yield* run.complete(Approval, Exit.succeed("ok"));
          case "failure":
            return yield* run.complete(Approval, Exit.die("failed"));
          case "interrupt":
            return yield* run.interrupt;
          case "stop":
            return yield* engine.interruptUnsafe(Approve, executionId);
          default:
            return yield* Effect.die("unknown operation");
        }
      }).pipe(Effect.orDie),
    );
    return {};
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const alias = yield* liveAlias;
          return Lambda.DurableFunctionEngine({ host: TestWorkflows, alias });
        }),
      ),
    ),
  ),
);
