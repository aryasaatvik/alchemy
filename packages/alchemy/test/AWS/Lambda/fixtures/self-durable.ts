import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";

export class SelfDurable extends Lambda.DurableFunction<SelfDurable>()(
  "SelfDurable",
) {}

export default SelfDurable.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const self = yield* Lambda.DurableFunctionScope;
    const host = yield* Lambda.Function;
    yield* host.listen((_event: { operation: "list" }) =>
      self.list().pipe(Effect.orDie),
    );
    return () => Effect.void;
  }),
);
