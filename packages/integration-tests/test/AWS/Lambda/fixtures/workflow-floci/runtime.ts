import { makeDurableListener } from "@alchemy.run/aws/Lambda/DurableBridge";
import { HandlerContext } from "@alchemy.run/aws/Lambda/InvocationDeadline";
import { makeWorkflowRunner } from "@alchemy.run/aws/Lambda/WorkflowFunction";
import type * as Lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import { services } from "./services.ts";
import { live } from "./workflows.ts";

const listener = Effect.runPromise(
  Effect.gen(function* () {
    const run = yield* makeWorkflowRunner(live);
    return yield* makeDurableListener({
      name: "Probe",
      run: (input) => run(input as Parameters<typeof run>[0]) as Effect.Effect<string>,
    });
  }).pipe(Effect.provide(services(process.env.AWS_ENDPOINT_URL!))),
);

export const handler = async (event: unknown, context: Lambda.Context) => {
  const result = (await listener)(event);
  if (!result) throw new Error("Expected durable invocation");
  return Effect.runPromise(Effect.provideService(result, HandlerContext, context));
};
