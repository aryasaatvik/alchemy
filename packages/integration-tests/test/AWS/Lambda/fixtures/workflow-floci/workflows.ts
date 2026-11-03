import {
  ActivityRetry,
  DeferredWait,
  DeferredWaitFailure,
} from "@alchemy.run/aws/Lambda/WorkflowFunction";
import * as Workflows from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow";
import { readInline } from "./activity-context.ts";

export class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  reason: Schema.String,
}) {}
export const Approval = DurableDeferred.make("approval", {
  success: Schema.String,
  error: Schema.Union([Rejected, DeferredWaitFailure]),
});
export const LoopApprovals = [0, 1].map((iteration) =>
  DurableDeferred.make(`loop/${iteration}`, { success: Schema.String, error: Rejected }),
);
export const Child = Workflow.make("Child", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});
export const Probe = Workflow.make("Probe", {
  payload: { id: Schema.String, mode: Schema.String },
  success: Schema.String,
  error: Schema.Union([Rejected, DeferredWaitFailure]),
  idempotencyKey: ({ id }) => id,
});
export const live = Layer.mergeAll(
  Workflows.layer(Child, ({ id }) => Effect.succeed(`child:${id}`)),
  Workflows.layer(Probe, ({ id, mode }) =>
    Effect.gen(function* () {
      if (mode === "context") return JSON.stringify(yield* readInline);
      if (mode === "early")
        yield* DurableClock.sleep({
          name: "before-await",
          duration: "8 seconds",
          inMemoryThreshold: 0,
        });
      if (mode === "loop") {
        const results: string[] = [];
        for (const deferred of LoopApprovals) results.push(yield* DurableDeferred.await(deferred));
        return results.join(",");
      }
      if (mode === "paged") {
        const [approval] = yield* Effect.all(
          [
            DurableDeferred.await(Approval),
            Effect.gen(function* () {
              yield* DurableClock.sleep({
                name: "before-history",
                duration: "1 second",
                inMemoryThreshold: 0,
              });
              for (let index = 0; index < 32; index++)
                yield* Activity.make({ name: `filler/${index}`, execute: Effect.void });
            }),
          ],
          { concurrency: "unbounded" },
        );
        return approval;
      }
      if (mode === "child") return yield* Child.execute({ id });
      if (mode === "clock") {
        yield* DurableClock.sleep({ name: "nap", duration: "2 seconds", inMemoryThreshold: 0 });
        return "awake";
      }
      if (mode === "identity") {
        const step = Activity.make({
          name: "same",
          success: Schema.String,
          execute: Effect.sync(() => crypto.randomUUID()),
        });
        const a = yield* step;
        yield* DurableClock.sleep({ name: "replay", duration: "1 second", inMemoryThreshold: 0 });
        const b = yield* step;
        return a === b ? "same" : "different";
      }
      if (mode === "retry" || mode === "exhaust" || mode === "restart") {
        return yield* Activity.make({
          name: "retry",
          success: Schema.String,
          error: Schema.Union([Rejected, DeferredWaitFailure]),
          execute: Effect.gen(function* () {
            const endpoint = process.env.AWS_ENDPOINT_URL!;
            const response = yield* Effect.promise(() =>
              fetch(`${endpoint}/pr3-workflow-attempts/attempt-${id}`),
            );
            const nativeAttempt = yield* Activity.CurrentAttempt;
            const attempt = response.ok
              ? Number(yield* Effect.promise(() => response.text())) + 1
              : 1;
            if (nativeAttempt !== attempt)
              return yield* Effect.die(
                new Error(`native attempt ${nativeAttempt}, counter ${attempt}`),
              );
            yield* Effect.promise(() =>
              fetch(`${endpoint}/pr3-workflow-attempts/attempt-${id}`, {
                method: "PUT",
                body: String(attempt),
              }),
            );
            if (mode === "exhaust" || attempt < 3)
              return yield* new Rejected({ reason: `attempt ${attempt}` });
            return `attempt ${attempt}`;
          }),
        }).annotate(ActivityRetry, {
          limit: 2,
          delay: mode === "restart" ? "6 seconds" : "1 second",
          backoff: "constant",
        });
      }
      if (mode === "timeout" || mode === "heartbeat") {
        const exit = yield* DurableDeferred.await(Approval).pipe(
          Effect.provideService(
            DeferredWait,
            mode === "timeout"
              ? { timeout: "2 seconds" }
              : { timeout: "30 seconds", heartbeatTimeout: "2 seconds" },
          ),
          Effect.exit,
        );
        if (exit._tag === "Failure")
          return Option.isSome(Cause.findErrorOption(exit.cause)) &&
            Cause.squash(exit.cause) instanceof DeferredWaitFailure
            ? "timed out"
            : Cause.pretty(exit.cause);
        return exit.value;
      }
      return yield* DurableDeferred.await(Approval);
    }),
  ),
);
