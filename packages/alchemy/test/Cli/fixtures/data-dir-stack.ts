import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "CliDataDir",
  { providers: Layer.empty, state: Alchemy.localState() },
  Effect.succeed({ message: "data dir probe" }),
);
