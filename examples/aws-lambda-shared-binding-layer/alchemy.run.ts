import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import ProducerA from "./src/ProducerA.ts";
import ProducerB from "./src/ProducerB.ts";

export default Alchemy.Stack(
  "SharedBindingLayer",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const a = yield* ProducerA;
    const b = yield* ProducerB;
    return {
      producerA: { functionName: a.functionName, url: a.functionUrl },
      producerB: { functionName: b.functionName, url: b.functionUrl },
    };
  }),
);
