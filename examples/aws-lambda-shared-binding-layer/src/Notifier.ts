import * as SQS from "alchemy/AWS/SQS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class Notifier extends Context.Service<
  Notifier,
  {
    notify(
      producer: string,
      body: string,
    ): Effect.Effect<{ messageId: string | undefined }>;
  }
>()("Notifier") {}

/**
 * One module-level Layer, provided by both Functions. Building it inside a
 * Function's init declares the queue and binds `sqs:SendMessage` to that
 * Function: each Function gets its own IAM statement and queue URL.
 */
export const NotifierSQS = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("Notifications");
    const sendMessage = yield* SQS.SendMessage(queue);

    return Notifier.of({
      notify: (producer, body) =>
        sendMessage({
          MessageBody: JSON.stringify({ producer, body }),
        }).pipe(
          Effect.map((result) => ({ messageId: result.MessageId })),
          Effect.orDie,
        ),
    });
  }),
).pipe(Layer.provide(SQS.SendMessageHttp));
