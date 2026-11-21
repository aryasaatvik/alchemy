import { makeDurableListener } from "@alchemy.run/aws/Lambda/DurableBridge";
import { HandlerContext } from "@alchemy.run/aws/Lambda/InvocationDeadline";
import { makeWorkflowRunner } from "@alchemy.run/aws/Lambda/WorkflowFunction";
import type { Context } from "aws-lambda";
import { Effect } from "effect";
import { services } from "../workflow-floci/services.ts";
import { live } from "./contract.ts";

const listener = Effect.runPromise(
  Effect.gen(function* () {
    const run = yield* makeWorkflowRunner(live);
    return yield* makeDurableListener({
      name: "CutoverProbe",
      run: (input) => run(input as Parameters<typeof run>[0]) as Effect.Effect<string>,
    });
  }).pipe(Effect.provide(services(process.env.AWS_ENDPOINT_URL!))),
);

export const handler = async (event: { DurableExecutionArn?: string }, context: Context) => {
  console.log(
    "CUTOVER_INVOCATION",
    JSON.stringify({
      arn: event.DurableExecutionArn,
      build: process.env.CUTOVER_BUILD,
      version: process.env.AWS_LAMBDA_FUNCTION_VERSION,
      requestId: context.awsRequestId,
    }),
  );
  const effect = (await listener)(event);
  if (effect === undefined) throw new Error("Expected a durable invocation");
  return Effect.runPromise(Effect.provideService(effect, HandlerContext, context));
};
