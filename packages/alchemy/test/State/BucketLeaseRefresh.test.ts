import { describe, expect, it } from "@alchemy.run/test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { makeBucketState, type BucketObjects } from "@/State/BucketState.ts";

const LEASE_TTL_MS = 60_000;
const stack = "bucket-state-test";
const stage = "test";

/** An in-memory bucket with S3-style versioned conditional writes. */
const memoryBucket = () => {
  const store = new Map<string, { text: string; version: string }>();
  let nextVersion = 0;
  const objects: BucketObjects = {
    listKeys: (prefix) =>
      Effect.sync(() => [...store.keys()].filter((key) => key.startsWith(prefix))),
    listChildren: (prefix) =>
      Effect.sync(() => [
        ...new Set(
          [...store.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length).split("/")[0]!)
            .filter((name) => name.length > 0),
        ),
      ]),
    read: (key) => Effect.sync(() => store.get(key)),
    write: (key, body, condition) =>
      Effect.sync(() => {
        const existing = store.get(key);
        if (condition !== undefined && "ifAbsent" in condition && existing !== undefined)
          return undefined;
        if (
          condition !== undefined &&
          "ifVersion" in condition &&
          existing?.version !== condition.ifVersion
        )
          return undefined;
        const version = String(++nextVersion);
        store.set(key, { text: body, version });
        return version;
      }),
    delete: (key, ifVersion) =>
      Effect.sync(() => {
        if (ifVersion === undefined || store.get(key)?.version === ifVersion) store.delete(key);
      }),
    deleteMany: (keys) =>
      Effect.sync(() => {
        for (const key of keys) store.delete(key);
      }),
  };
  return objects;
};

/**
 * A clock whose sleeps never finish: the lease refresh is scheduled but
 * never runs, as when a build keeps the event loop busy. Time moves only
 * when the test moves it.
 */
const starvedClock = () => {
  let now = 1_000_000;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: () => Effect.never,
  };
  return {
    clock,
    advance: (ms: number) =>
      Effect.sync(() => {
        now += ms;
      }),
  };
};

const makeStore = (objects: BucketObjects) =>
  makeBucketState({ id: "memory", label: "memory", objects: Effect.succeed(objects) });

describe("makeBucketState lease", { tags: ["unit"] }, () => {
  it.effect("keeps a lease whose refresh ran later than its TTL", () =>
    Effect.gen(function* () {
      const objects = memoryBucket();
      const { clock, advance } = starvedClock();
      yield* Effect.gen(function* () {
        const holder = yield* makeStore(objects);
        yield* holder.setOutput({ stack, stage, value: { step: 1 } });

        yield* advance(3 * LEASE_TTL_MS);
        yield* holder.setOutput({ stack, stage, value: { step: 2 } });
        expect(yield* holder.getOutput({ stack, stage })).toEqual({ step: 2 });

        // The holder's check extended the lease, so it is closed to another deploy again.
        const error = yield* Effect.scoped(
          Effect.flip(
            makeStore(objects).pipe(
              Effect.flatMap((other) => other.setOutput({ stack, stage, value: { step: 3 } })),
            ),
          ),
        );
        expect(error.message).toContain("another deploy holds");
      }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, clock));
    }),
  );

  it.effect("loses an expired lease that another deploy took", () =>
    Effect.gen(function* () {
      const objects = memoryBucket();
      const { clock, advance } = starvedClock();
      yield* Effect.gen(function* () {
        const holder = yield* makeStore(objects);
        yield* holder.setOutput({ stack, stage, value: { step: 1 } });

        yield* advance(2 * LEASE_TTL_MS);
        yield* Effect.scoped(
          makeStore(objects).pipe(
            Effect.flatMap((other) => other.setOutput({ stack, stage, value: { step: 2 } })),
          ),
        );

        const error = yield* Effect.flip(holder.setOutput({ stack, stage, value: { step: 3 } }));
        expect(error.message).toContain("was lost mid-run");
      }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, clock));
    }),
  );
});
