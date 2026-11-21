import { makeWorkflowEngine } from "@alchemy.run/aws/Lambda/WorkflowFunction";
import * as Workflows from "alchemy/Workflows";
import { Effect, Exit } from "effect";
import { WorkflowEngine } from "effect/workflow";
import { services } from "../workflow-floci/services.ts";
import { Approval, completion, Future, Probe } from "./contract.ts";

interface Request {
  functionName: string;
  endpoint: string;
  operation: "start" | "success" | "failure" | "early" | "interrupt" | "resume" | "status";
  id: string;
  executionRef?: string;
  suspend?: boolean;
  qualifier?: string;
}

const request: Request = JSON.parse(process.argv[2]!);
const endpoint = new URL(request.endpoint);
if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:" || !endpoint.port)
  throw new Error("Cutover client requires disposable, loopback Floci");

const output = await Effect.runPromise(
  Effect.gen(function* () {
    const engine = yield* makeWorkflowEngine(request.functionName, request.qualifier ?? "live");
    if (request.operation === "start") {
      const client = yield* Workflows.RunWorkflow(Probe).pipe(
        Effect.provideService(Workflows.Implemented("CutoverProbe"), true),
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      );
      const { executionId, executionRef } = yield* client.start({
        id: request.id,
        suspend: request.suspend ?? false,
      });
      return { executionId, executionRef };
    }

    const saved = Workflows.makeRun(engine, Probe, request.id, request.executionRef);
    switch (request.operation) {
      case "status":
        return yield* saved.status;
      case "early":
        return yield* Effect.flip(saved.complete(Future, Exit.succeed("premature")));
      case "interrupt":
        yield* saved.interrupt;
        return null;
      case "resume":
        yield* engine.resume(Probe, request.id);
        return null;
      case "success":
      case "failure":
        yield* saved.complete(Approval, completion[request.operation]);
        return null;
    }
  }).pipe(Effect.provide(services(endpoint.origin))),
);
console.log(JSON.stringify(output));
