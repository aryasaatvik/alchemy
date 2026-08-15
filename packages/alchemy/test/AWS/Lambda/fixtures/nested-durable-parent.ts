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
      (event: {
        operation:
          | "start"
          | "anonymous-start"
          | "missing-start"
          | "list"
          | "implicit-list";
      }) => {
        switch (event.operation) {
          case "start": {
            return reference
              .start({
                name: "nested-runtime",
                qualifier: "live",
              })
              .pipe(
                Effect.map((started) => {
                  const executionArn: string = started.executionArn;
                  return { ...started, executionArn };
                }),
              );
          }
          case "anonymous-start": {
            return reference.start({ qualifier: "live" }).pipe(
              Effect.map((started) => {
                const executionArn: string | undefined = started.executionArn;
                return { ...started, executionArn };
              }),
            );
          }
          case "missing-start":
            return reference.start({
              name: "missing-runtime",
              qualifier: "live",
            });
          case "list":
            return reference.list({
              name: "nested-runtime",
              qualifier: "live",
            });
          case "implicit-list":
            return durable.list({
              name: "nested-runtime",
              qualifier: "live",
            });
        }
      },
    );

    return {};
  }),
);
