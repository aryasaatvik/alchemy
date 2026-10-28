import * as AWS from "@alchemy.run/aws";
import { WorkflowCallbackStore } from "@alchemy.run/aws/Lambda/WorkflowFunction";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

// Shared by the host and caller; callback registrations must survive cold starts.
export const Callbacks = AWS.S3.Bucket("WorkflowCallbacks", { forceDestroy: true });
export const CallbacksLive = Layer.effect(
  WorkflowCallbackStore,
  Effect.gen(function* () {
    const bucket = yield* Callbacks;
    const put = yield* AWS.S3.PutObject(bucket);
    const get = yield* AWS.S3.GetObject(bucket);
    return {
      register: (token, callbackId) =>
        put({ Key: token, Body: callbackId }).pipe(Effect.orDie, Effect.asVoid),
      // Tests only signal after proving registration. No early-completion policy here.
      lookup: (token) =>
        get({ Key: token }).pipe(
          Effect.flatMap((object) => Stream.mkString(Stream.decodeText(object.Body!))),
          Effect.orDie,
        ),
    };
  }),
).pipe(Layer.provide(Layer.mergeAll(AWS.S3.PutObjectHttp, AWS.S3.GetObjectHttp)));
