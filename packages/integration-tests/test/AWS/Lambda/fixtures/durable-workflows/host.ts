import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Duration from "effect/Duration";
import path from "pathe";
import { CallbacksLive } from "./callbacks.ts";
import { Approve, Checkout, Greet, Nap, Parent, WorkflowsLive } from "./workflows.ts";

const main = path.resolve(import.meta.dirname, "host.ts");

/** A Lambda durable function that runs the test workflows. */
export class TestWorkflows extends Lambda.WorkflowFunction<TestWorkflows>()("TestWorkflows", {
  workflows: [Greet, Nap, Approve, Checkout, Parent],
}) {}

export default TestWorkflows.make(
  {
    main,
    ...(process.env.WORKFLOW_FLOCI_ENDPOINT
      ? { env: { AWS_ENDPOINT_URL: "http://floci:4566" } }
      : {}),
    executionTimeout: Duration.hours(1),
    retentionPeriod: "1 day",
    timeout: Duration.seconds(60),
    // Runs start on the alias, not `$LATEST`.
    alias: "live",
  },
  WorkflowsLive,
  CallbacksLive,
);
