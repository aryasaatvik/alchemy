import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { cachedFunction } from "@/Util/cached-function.ts";

describe("cachedFunction", { tags: ["unit", "local"] }, () => {
  it.effect("concurrent callers share one keyed execution", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cached = yield* cachedFunction((key: string) =>
        Effect.gen(function* () {
          calls++;
          yield* Effect.yieldNow;
          return key;
        }),
      );
      const results = yield* Effect.all(
        Array.from({ length: 1000 }, () => cached("same")),
        { concurrency: "unbounded" },
      );
      expect(calls).toBe(1);
      expect(results.every((value) => value === "same")).toBe(true);
      expect(yield* cached("other")).toBe("other");
      expect(calls).toBe(2);
    }),
  );

  it.live(
    "a synchronous factory defect settles the owner and allows waiting callers to retry",
    () =>
      Effect.gen(function* () {
        const defect = new Error("factory failed synchronously");
        let calls = 0;
        const cached = yield* cachedFunction(() => {
          calls++;
          if (calls === 1) throw defect;
          return Effect.succeed(42);
        });
        const owner = yield* Effect.forkChild(cached());
        const first = yield* Fiber.await(owner);
        expect(Exit.isFailure(first)).toBe(true);
        if (Exit.isFailure(first)) {
          expect(
            first.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect === defect,
            ),
          ).toBe(true);
        }
        const waiters = yield* Effect.all([cached(), cached()], { concurrency: "unbounded" }).pipe(
          Effect.timeout("1 second"),
        );
        expect(waiters).toEqual([42, 42]);
        expect(calls).toBe(2);
      }),
  );

  it.live("an interrupted owner settles waiters and permits retry", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let calls = 0;
      const cached = yield* cachedFunction(() =>
        Effect.suspend(() => {
          calls++;
          return calls === 1
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(42);
        }),
      );
      const owner = yield* Effect.forkChild(cached());
      yield* Deferred.await(started);
      const waiter = yield* Effect.forkChild(cached());
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(owner);
      const result = yield* Fiber.await(waiter).pipe(Effect.timeout("1 second"));
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* cached()).toBe(42);
      expect(calls).toBe(2);
    }),
  );
});
