import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";

export class NestedDurable extends Lambda.DurableFunction<NestedDurable>()(
  "NestedDurable",
  { main: import.meta.url },
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return yield* Effect.die("Nested durable init must not run in the parent Lambda");
    }
    return () => Effect.void;
  }),
) {}

export class NestedDurableParent extends Lambda.Function<NestedDurableParent>()(
  "NestedDurableParent",
) {}

export default NestedDurableParent.make(
  { main: import.meta.url, functionUrl: false },
  Effect.gen(function* () {
    const durable = yield* NestedDurable;
    const explicit = yield* Lambda.reference(durable);
    const host = yield* Lambda.Function;

    yield* host.listen(
      (event: {
        operation:
          | "start"
          | "direct-start"
          | "anonymous-start"
          | "missing-start"
          | "ambiguous-start"
          | "list"
          | "implicit-list";
      }) =>
        Effect.gen(function* () {
          switch (event.operation) {
            case "start": {
              const started = yield* explicit.start({
                name: "nested-runtime",
                qualifier: "live",
              });
              const executionArn: string = started.executionArn;
              return { ...started, executionArn };
            }
            case "direct-start":
              return yield* explicit.start({
                name: "direct-runtime",
                qualifier: "live",
              });
            case "anonymous-start": {
              const started = yield* explicit.start({ qualifier: "live" });
              const executionArn: string | undefined = started.executionArn;
              return { ...started, executionArn };
            }
            case "missing-start":
              return yield* explicit.start({
                name: "missing-runtime",
                qualifier: "live",
              });
            case "ambiguous-start":
              return yield* explicit.start({
                name: "ambiguous-runtime",
                qualifier: "live",
              });
            case "list":
              return yield* explicit.list({
                name: "nested-runtime",
                qualifier: "live",
              });
            case "implicit-list":
              return yield* durable.list({
                name: "nested-runtime",
                qualifier: "live",
              });
          }
        }).pipe(Effect.orDie),
    );

    return {};
  }),
);
