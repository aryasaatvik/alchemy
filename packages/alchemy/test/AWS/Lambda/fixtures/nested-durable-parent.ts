import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";

export class NestedDurable extends Lambda.DurableFunction<NestedDurable>()(
  "NestedDurable",
) {}

export class NestedDurableParent extends Lambda.Function<NestedDurableParent>()(
  "NestedDurableParent",
) {}

export default NestedDurableParent.make(
  { main: import.meta.url, url: false },
  Effect.gen(function* () {
    // This is the runtime shape of a nested DurableFunction reference: the
    // parent owns only the child Function resource proxy, not the child's
    // handler implementation or its in-process durable handle.
    const child = yield* Lambda.Function("NestedDurable", {
      main: import.meta.url,
      isExternal: true,
      url: false,
    });
    const durable = yield* NestedDurable.pipe(
      Effect.provideService(
        (NestedDurable as unknown as { Self: typeof Lambda.Function.Self })
          .Self,
        child,
      ),
    );
    const reference = yield* Lambda.reference(durable);
    const host = yield* Lambda.Function;

    yield* host.listen(
      (event: { operation: "start" | "list" | "implicit-list" }) =>
        event.operation === "start"
          ? reference.start({ name: "nested-runtime", qualifier: "live" })
          : event.operation === "list"
            ? reference.list({ name: "nested-runtime", qualifier: "live" })
            : durable.list({ name: "nested-runtime", qualifier: "live" }),
    );

    return {};
  }),
);
