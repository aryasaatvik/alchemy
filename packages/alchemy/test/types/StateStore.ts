import * as AWS from "@/AWS/index.ts";
import * as Alchemy from "@/index.ts";
import type { StackServices } from "@/Stack.ts";
import type { State } from "@/State/State.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// The S3 state layer outputs exactly `State`, so a stage-selected store (the
// pattern a Stack's `state` option takes) type-checks against the Stack's
// state contract.
const selectedState: Layer.Layer<State, never, StackServices> = Layer.unwrap(
  Alchemy.Stage.pipe(
    Effect.map((stage) =>
      stage === "local" ? Alchemy.localState() : AWS.state({ prefix: "app" }),
    ),
  ),
);

// @ts-expect-error — the AWS services the layer builds internally are not
// part of its output
const leaked: Layer.Layer<AWS.AWSEnvironment, never, AWS.S3StateRequirements> =
  AWS.state();

void selectedState;
void leaked;
