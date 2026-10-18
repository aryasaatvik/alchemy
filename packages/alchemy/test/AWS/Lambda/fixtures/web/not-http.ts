// Web Functions only receive HTTP. Unsupported hosts remain requirements of
// the implementation layer, and these fixtures fail at plan.
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Lambda from "@/AWS/Lambda";
import type { Providers } from "@/AWS/Providers.ts";
import * as SQS from "@/AWS/SQS";
import { ServerHost } from "@/Server";

export class EventSourceWeb extends Lambda.WebFunction<Lambda.WebFunction>()("EventSourceWeb") {}

export const EventSourceWebLive = EventSourceWeb.make(
  { main: import.meta.url, authType: "ApplicationManaged" },
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("WebEventSourceQueue");
    yield* SQS.consumeQueueMessages(queue, () => Effect.void);
    return {};
  }).pipe(Effect.provide(Lambda.QueueEventSource)),
);

export class BackgroundLoopWeb extends Lambda.WebFunction<Lambda.WebFunction>()(
  "BackgroundLoopWeb",
) {}

export const BackgroundLoopWebLive = BackgroundLoopWeb.make(
  { main: import.meta.url, authType: "ApplicationManaged" },
  Effect.gen(function* () {
    const host = yield* ServerHost;
    yield* host.run(Effect.never);
    return {};
  }),
);

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type _EventSourceNeedsFunction = Expect<
  Equal<Layer.Services<typeof EventSourceWebLive>, Providers | Lambda.Function>
>;
type _BackgroundLoopNeedsServer = Expect<
  Equal<Layer.Services<typeof BackgroundLoopWebLive>, Providers | ServerHost>
>;
