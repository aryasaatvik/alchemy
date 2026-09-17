import * as Alchemy from "@/index.ts";
import * as AWS from "@/AWS/index.ts";
import type { StackServices } from "@/Stack.ts";
import type { State } from "@/State/State.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const selectedState: Layer.Layer<State, never, StackServices> = Layer.unwrap(
  Alchemy.Stage.pipe(
    Effect.map((stage) =>
      stage === "local" ? Alchemy.localState() : AWS.state(),
    ),
  ),
);

void selectedState;
