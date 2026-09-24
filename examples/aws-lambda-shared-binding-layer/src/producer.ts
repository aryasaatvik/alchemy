import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Notifier, NotifierSQS } from "./Notifier.ts";

/** A Function's init: provides the shared {@link NotifierSQS} Layer. */
export const producer = (name: string) =>
  Effect.gen(function* () {
    const notifier = yield* Notifier;

    return {
      fetch: Effect.gen(function* () {
        const result = yield* notifier.notify(name, "hello");
        return yield* HttpServerResponse.json({ producer: name, ...result });
      }),
    };
  }).pipe(Effect.provide(NotifierSQS));
