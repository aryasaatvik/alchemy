/**
 * A module-level binding Layer shared by several hosts grants each host.
 *
 * `SQS.SendMessage(queue)` records its IAM statement on the ambient
 * `Binding.Host` and its queue URL in that host's env when it executes at
 * plan. When two Functions provide the same `Layer.effect(...)` value, each
 * Function's init must run that Layer for itself — a build reused from the
 * other Function would leave this one without the grant or the env. A
 * Function declared inside another Function's init is the case that would
 * otherwise see the enclosing Function's builds; a Worker declared inside
 * another Worker's init is the same case on Cloudflare.
 *
 * At runtime nothing host-scoped happens, so nested hosts share the builds
 * of the ambient memo map.
 */
import * as AWS from "@/AWS";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Cloudflare from "@/Cloudflare";
import { isResolved } from "@/Diff.ts";
import * as Provider from "@/Provider.ts";
import { inMemoryState } from "@/State/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { Credentials } from "@distilled.cloud/aws";
import { describe, expect } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const functionProvider = Provider.succeed(AWS.Lambda.Function, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* ({ news }) {
    if (!isResolved(news)) return undefined;
  }),
  reconcile: Effect.fn(function* ({ id }) {
    return {
      functionArn: `arn:aws:lambda:us-east-1:123456789012:function:${id}`,
      functionName: id,
      functionUrl: undefined,
      roleName: `${id}-role`,
      roleArn: `arn:aws:iam::123456789012:role/${id}-role`,
      code: { hash: "hermetic" },
    };
  }),
  delete: () => Effect.void,
});

const queueProvider = Provider.succeed(AWS.SQS.Queue, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {}),
  reconcile: Effect.fn(function* ({ id }) {
    return {
      queueName: id,
      queueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${id}`,
      queueArn: `arn:aws:sqs:us-east-1:123456789012:${id}`,
    } as any;
  }),
  delete: () => Effect.void,
});

const workerProvider = Provider.succeed(
  Cloudflare.Worker as any,
  {
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* () {
      return yield* Effect.die("plan-only");
    }),
    delete: () => Effect.void,
  } as any,
);

const namespaceProvider = Provider.succeed(Cloudflare.KV.Namespace, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {}),
  reconcile: Effect.fn(function* () {
    return yield* Effect.die("plan-only");
  }),
  delete: () => Effect.void,
} as any);

const { test } = Test.make({
  providers: Layer.mergeAll(
    functionProvider,
    queueProvider,
    workerProvider,
    namespaceProvider,
    Credentials.mock,
  ),
  state: inMemoryState(),
});

class Notifier extends Context.Service<
  Notifier,
  { readonly send: (body: string) => Effect.Effect<unknown, unknown> }
>()("Notifier") {}

/** One module-level Layer value, provided to every host below. */
const NotifierSQS = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const queue = yield* AWS.SQS.Queue("SharedQueue");
    const send = yield* AWS.SQS.SendMessage(queue);
    return Notifier.of({ send: (body) => send({ MessageBody: body }) });
  }),
);

const NotifierLive = NotifierSQS.pipe(Layer.provide(AWS.SQS.SendMessageHttp));

const init = Effect.gen(function* () {
  const notifier = yield* Notifier;
  return { fetch: notifier.send("hello").pipe(Effect.orDie) as any };
});

const main = import.meta.filename;

class Cache extends Context.Service<
  Cache,
  {
    readonly get: (
      key: string,
    ) => Effect.Effect<unknown, unknown, RuntimeContext>;
  }
>()("Cache") {}

/** One module-level KV Layer, provided to both Workers. */
const CacheKV = Layer.effect(
  Cache,
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.KV.Namespace("SharedKV");
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
    return Cache.of({ get: (key) => kv.get(key) });
  }),
);

const CacheLive = CacheKV.pipe(
  Layer.provide(Cloudflare.KV.ReadWriteNamespaceBinding),
);

const workerInit = Effect.gen(function* () {
  const cache = yield* Cache;
  return { fetch: cache.get("key").pipe(Effect.orDie) as any };
});

const sendStatements = (plan: any, id: string) =>
  (plan.resources[id]?.bindings ?? [])
    .flatMap((row: any) => row.data?.policyStatements ?? [])
    .filter((statement: any) =>
      [statement.Action].flat().includes("sqs:SendMessage"),
    );

const envKeys = (plan: any, id: string) =>
  Object.keys(plan.resources[id]?.props?.env ?? {}).filter((key) =>
    key.toLowerCase().includes("sharedqueue"),
  );

const expectGranted = (plan: any, ids: string[]) => {
  for (const id of ids) {
    expect({ id, statements: sendStatements(plan, id).length }).toEqual({
      id,
      statements: 1,
    });
    expect({ id, env: envKeys(plan, id).length }).toEqual({ id, env: 1 });
  }
};

describe("a binding Layer shared by two Functions", () => {
  test.provider("Effect.provide of the shared Layer in each init", (stack) =>
    Effect.gen(function* () {
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          yield* AWS.Lambda.Function(
            "ProducerA",
            { main },
            init.pipe(Effect.provide(NotifierLive)),
          );
          yield* AWS.Lambda.Function(
            "ProducerB",
            { main },
            init.pipe(Effect.provide(NotifierLive)),
          );
        }),
      );
      expectGranted(plan, ["ProducerA", "ProducerB"]);
    }),
  );

  test.provider(
    "Layer.provide of the binding implementation at each call site",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Lambda.Function(
              "ProducerA",
              { main },
              init.pipe(
                Effect.provide(
                  NotifierSQS.pipe(Layer.provide(AWS.SQS.SendMessageHttp)),
                ),
              ),
            );
            yield* AWS.Lambda.Function(
              "ProducerB",
              { main },
              init.pipe(
                Effect.provide(
                  NotifierSQS.pipe(Layer.provide(AWS.SQS.SendMessageHttp)),
                ),
              ),
            );
          }),
        );
        expectGranted(plan, ["ProducerA", "ProducerB"]);
      }),
  );

  test.provider("a Function declared inside another Function's init", (stack) =>
    Effect.gen(function* () {
      const plan = yield* stack.plan(
        AWS.Lambda.Function(
          "ProducerA",
          { main },
          Effect.gen(function* () {
            const notifier = yield* Notifier;
            yield* AWS.Lambda.Function(
              "ProducerB",
              { main },
              init.pipe(Effect.provide(NotifierLive)),
            );
            return {
              fetch: notifier.send("hello").pipe(Effect.orDie) as any,
            };
          }).pipe(Effect.provide(NotifierLive)),
        ),
      );
      expectGranted(plan, ["ProducerA", "ProducerB"]);
    }),
  );

  test.provider(
    "a class Function whose Layer is provided inside another Function's init",
    (stack) =>
      Effect.gen(function* () {
        class ProducerB extends AWS.Lambda.Function<ProducerB>()("ProducerB") {}
        const ProducerBLive = ProducerB.make(
          { main },
          init.pipe(Effect.provide(NotifierLive)),
        );
        const plan = yield* stack.plan(
          AWS.Lambda.Function(
            "ProducerA",
            { main },
            Effect.gen(function* () {
              const notifier = yield* Notifier;
              yield* ProducerB;
              return {
                fetch: notifier.send("hello").pipe(Effect.orDie) as any,
              };
            }).pipe(Effect.provide(Layer.merge(NotifierLive, ProducerBLive))),
          ),
        );
        expectGranted(plan, ["ProducerA", "ProducerB"]);
      }),
  );

  test.provider("a Worker declared inside another Worker's init", (stack) =>
    Effect.gen(function* () {
      const plan = yield* stack.plan(
        Cloudflare.Worker(
          "OuterWorker",
          { main },
          Effect.gen(function* () {
            const cache = yield* Cache;
            yield* Cloudflare.Worker(
              "InnerWorker",
              { main },
              workerInit.pipe(Effect.provide(CacheLive)),
            );
            return {
              fetch: cache.get("key").pipe(Effect.orDie) as any,
            };
          }).pipe(Effect.provide(CacheLive)),
        ),
      );
      for (const id of ["OuterWorker", "InnerWorker"]) {
        const kv = (plan.resources[id]?.bindings ?? [])
          .flatMap((row: any) => row.data?.bindings ?? [])
          .filter((binding: any) => binding.type === "kv_namespace");
        expect({ id, kv: kv.map((b: any) => b.name) }).toEqual({
          id,
          kv: ["SharedKV"],
        });
      }
    }),
  );
});

describe("a Layer shared by nested hosts", () => {
  const nested = Effect.gen(function* () {
    let builds = 0;
    const Counted = Layer.effect(
      Notifier,
      Effect.sync(() => {
        builds++;
        return Notifier.of({ send: () => Effect.void });
      }),
    );
    const program = AWS.Lambda.Function(
      "Outer",
      { main },
      Effect.gen(function* () {
        yield* Notifier;
        yield* AWS.Lambda.Function(
          "Inner",
          { main },
          init.pipe(Effect.provide(Counted)),
        );
        return {};
      }).pipe(Effect.provide(Counted)),
    );
    return { program, builds: () => builds };
  });

  test.provider("builds it once per nested host at plan", (stack) =>
    Effect.gen(function* () {
      const { program, builds } = yield* nested;
      yield* stack.plan(program);
      expect(builds()).toBe(2);
    }),
  );

  test.provider("builds it once for all nested hosts at runtime", (stack) =>
    Effect.gen(function* () {
      const { program, builds } = yield* nested;
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = globalThis.__ALCHEMY_RUNTIME__;
          globalThis.__ALCHEMY_RUNTIME__ = true;
          return previous;
        }),
        () => stack.plan(program),
        (previous) =>
          Effect.sync(() => {
            globalThis.__ALCHEMY_RUNTIME__ = previous;
          }),
      );
      expect(builds()).toBe(1);
    }),
  );
});
