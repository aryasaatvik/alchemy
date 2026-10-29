import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { WorkflowEngine } from "effect/workflow";
import { TestWorkflows } from "./durable-workflows/host.ts";
import { liveAlias } from "./durable-workflows/target.ts";
import { Approve, Approval } from "./durable-workflows/workflows.ts";

export class AliasWorkflowCaller extends Lambda.Function<AliasWorkflowCaller>()(
  "AliasWorkflowCaller",
) {}
export default AliasWorkflowCaller.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const client = yield* Workflows.RunWorkflow(Approve);
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const host = yield* Lambda.Function;
    yield* host.listen((event: { operation: string }) =>
      Effect.gen(function* () {
        const run = client.get("execution");
        switch (event.operation) {
          case "start":
            return yield* client.start({ id: "execution" }).pipe(Effect.map((r) => r.executionRef));
          case "status":
            return yield* run.status;
          case "success":
            return yield* run.complete(Approval, Exit.succeed("ok"));
          case "failure":
            return yield* run.complete(Approval, Exit.die("failed"));
          case "interrupt":
            return yield* run.interrupt;
          case "stop":
            return yield* engine.interruptUnsafe(Approve, "execution");
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
