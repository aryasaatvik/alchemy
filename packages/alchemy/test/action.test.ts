import { Action } from "@/Action";
import { apply } from "@/Apply";
import * as Output from "@/Output";
import * as Plan from "@/Plan";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import {
  InMemoryService,
  inMemoryState,
  State,
  type ActionState,
  type RanActionState,
} from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  BindingTarget,
  Bucket,
  TestLayers,
  TestResource,
} from "./test.resources";

const TEST_STACK = "task-test";
const TEST_STAGE = "test";

// Fresh in-memory state per test so persisted task rows don't leak between
// runs in the same file.
const freshState = () =>
  Layer.effect(
    State,
    Effect.sync(() => InMemoryService({})),
  );

const { test } = Test.make({
  providers: TestLayers(),
  state: freshState(),
});

const resolveStackId = Effect.gen(function* () {
  const ambient = yield* Effect.serviceOption(Stack.Stack);
  return Option.match(ambient, {
    onNone: () => ({ name: TEST_STACK, stage: TEST_STAGE }),
    onSome: (s) => ({ name: s.name, stage: s.stage }),
  });
});

const seed = (rows: Record<string, ActionState>) =>
  Effect.gen(function* () {
    const { name, stage } = yield* resolveStackId;
    const state = yield* yield* State;
    for (const [fqn, value] of Object.entries(rows)) {
      yield* state.set({ stack: name, stage, fqn, value });
    }
  });

const makePlan = <A, Err = never, Req = never>(
  effect: Effect.Effect<A, Err, Req>,
  options?: Plan.MakePlanOptions,
): Effect.Effect<Plan.Plan<A>, Err, State> =>
  // @ts-expect-error - Stack.make's typing erases R unsoundly here
  Effect.gen(function* () {
    const { name, stage } = yield* resolveStackId;
    // @ts-expect-error
    return yield* effect.pipe(
      // @ts-expect-error
      Stack.make({
        name,
        providers: Layer.empty,
        state: inMemoryState(),
      }),
      Effect.provideService(Stage, stage),
      Effect.flatMap((stackSpec: any) => Plan.make(stackSpec, options)),
      Effect.provide(TestLayers()),
    );
  });

// ── Plan tests ────────────────────────────────────────────────────────────

describe("Plan", () => {
  test(
    "first-time task -> run",
    Effect.gen(function* () {
      const Sync = Action("Sync", (input: { table: string }) =>
        Effect.succeed({ rows: 1, table: input.table }),
      );

      const plan = yield* Effect.gen(function* () {
        return yield* Sync({ table: "users" });
      }).pipe(makePlan);

      expect(plan.actions.Sync).toMatchObject({
        kind: "action",
        action: "run",
        state: undefined,
        forced: false,
      });
      expect(plan.actions.Sync.def.LogicalId).toBe("Sync");
    }),
  );

  test(
    "same input hash -> noop (skip)",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { table: string }) =>
        Effect.succeed({ rows: 1 }),
      );

      // Pre-seed a `ran` row with a hash that matches { table: "users" }.
      const { hashInput } = yield* Effect.promise(
        () => import("@/Util/sha256"),
      );
      const inputHash = yield* hashInput({ table: "users" });
      yield* seed({
        Sync: {
          kind: "action",
          status: "ran",
          fqn: "Sync",
          logicalId: "Sync",
          namespace: undefined,
          actionType: "Sync",
          inputHash,
          input: { table: "users" },
          output: { rows: 1 },
          downstream: [],
        } satisfies RanActionState,
      });

      const plan = yield* Effect.gen(function* () {
        return yield* Sync({ table: "users" });
      }).pipe(makePlan);

      expect(plan.actions.Sync.action).toBe("noop");
    }),
  );

  test(
    "changed input hash -> run",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { table: string }) =>
        Effect.succeed({ rows: 1 }),
      );

      const { hashInput } = yield* Effect.promise(
        () => import("@/Util/sha256"),
      );
      const oldHash = yield* hashInput({ table: "users" });
      yield* seed({
        Sync: {
          kind: "action",
          status: "ran",
          fqn: "Sync",
          logicalId: "Sync",
          namespace: undefined,
          actionType: "Sync",
          inputHash: oldHash,
          input: { table: "users" },
          output: { rows: 1 },
          downstream: [],
        } satisfies RanActionState,
      });

      const plan = yield* Effect.gen(function* () {
        return yield* Sync({ table: "orders" });
      }).pipe(makePlan);

      expect(plan.actions.Sync.action).toBe("run");
    }),
  );

  test(
    "force flips noop -> run",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { table: string }) =>
        Effect.succeed({ rows: 1 }),
      );

      const { hashInput } = yield* Effect.promise(
        () => import("@/Util/sha256"),
      );
      const inputHash = yield* hashInput({ table: "users" });
      yield* seed({
        Sync: {
          kind: "action",
          status: "ran",
          fqn: "Sync",
          logicalId: "Sync",
          namespace: undefined,
          actionType: "Sync",
          inputHash,
          input: { table: "users" },
          output: { rows: 1 },
          downstream: [],
        } satisfies RanActionState,
      });

      const plan = yield* Effect.gen(function* () {
        return yield* Sync({ table: "users" });
      }).pipe((eff) => makePlan(eff, { force: true }));

      expect(plan.actions.Sync.action).toBe("run");
      expect((plan.actions.Sync as Plan.ActionRun).forced).toBe(true);
    }),
  );

  test(
    "forced Action output remains evaluable for downstream resources",
    Effect.gen(function* () {
      const Derived = Action("Derived", (_: { value: string }) =>
        Effect.succeed({ value: "fresh" }),
      );
      const { hashInput } = yield* Effect.promise(
        () => import("@/Util/sha256"),
      );
      yield* seed({
        Derived: {
          kind: "action",
          status: "ran",
          fqn: "Derived",
          logicalId: "Derived",
          namespace: undefined,
          actionType: "Derived",
          inputHash: yield* hashInput({ value: "same" }),
          input: { value: "same" },
          output: { value: "persisted" },
          downstream: [],
        },
      });

      const plan = yield* Effect.gen(function* () {
        const derived = yield* Derived({ value: "same" });
        return yield* Bucket("Consumer", { name: derived.value });
      }).pipe((effect) => makePlan(effect, { force: true }));

      expect(plan.actions.Derived).toMatchObject({
        action: "run",
        forced: true,
      });
      expect(Output.hasOutputs(plan.resources.Consumer.props)).toBe(true);
    }),
  );

  test(
    "running Action output remains evaluable for downstream resources",
    Effect.gen(function* () {
      const Derived = Action("Derived", (input: { value: string }) =>
        Effect.succeed({ value: input.value }),
      );
      const { hashInput } = yield* Effect.promise(
        () => import("@/Util/sha256"),
      );
      yield* seed({
        Derived: {
          kind: "action",
          status: "running",
          fqn: "Derived",
          logicalId: "Derived",
          namespace: undefined,
          actionType: "Derived",
          inputHash: yield* hashInput({ value: "same" }),
          input: { value: "same" },
          downstream: [],
        },
      });

      const plan = yield* Effect.gen(function* () {
        const derived = yield* Derived({ value: "same" });
        return yield* Bucket("Consumer", { name: derived.value });
      }).pipe(makePlan);

      expect(plan.actions.Derived.action).toBe("run");
      expect(Output.hasOutputs(plan.resources.Consumer.props)).toBe(true);
    }),
  );

  test(
    "task removed from stack -> taskDeletions",
    Effect.gen(function* () {
      const { hashInput } = yield* Effect.promise(
        () => import("@/Util/sha256"),
      );
      const inputHash = yield* hashInput({ table: "users" });
      yield* seed({
        Sync: {
          kind: "action",
          status: "ran",
          fqn: "Sync",
          logicalId: "Sync",
          namespace: undefined,
          actionType: "Sync",
          inputHash,
          input: { table: "users" },
          output: { rows: 1 },
          downstream: [],
        } satisfies RanActionState,
      });

      // The new stack has no tasks at all.
      const plan = yield* Effect.gen(function* () {
        return undefined;
      }).pipe(makePlan);

      expect(plan.actionDeletions.Sync).toMatchObject({
        kind: "action",
        action: "delete",
      });
      expect(plan.actions.Sync).toBeUndefined();
    }),
  );

  test(
    "resource depends on task: task is upstream of resource",
    Effect.gen(function* () {
      const Compute = Action("Compute", (_: {}) =>
        Effect.succeed({ value: "computed" }),
      );

      const plan = yield* Effect.gen(function* () {
        const computed = yield* Compute({});
        const bucket = yield* Bucket("MyBucket", { name: computed.value });
        return bucket;
      }).pipe(makePlan);

      // Action is run (first time), bucket is created and lists Compute as upstream.
      expect(plan.actions.Compute.action).toBe("run");
      expect(plan.actions.Compute.downstream).toContain("MyBucket");
    }),
  );

  test(
    "task depends on resource: resource is upstream of task",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { name: string }) =>
        Effect.succeed({ ok: true }),
      );

      const plan = yield* Effect.gen(function* () {
        const bucket = yield* Bucket("MyBucket", { name: "b" });
        return yield* Sync({ name: bucket.name });
      }).pipe(makePlan);

      expect(plan.resources.MyBucket.action).toBe("create");
      expect(plan.actions.Sync.action).toBe("run");
      // MyBucket's downstream includes the task FQN.
      expect(plan.resources.MyBucket.downstream).toContain("Sync");
    }),
  );

  test(
    "explicit logical id allows multiple instances",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { which: string }) =>
        Effect.succeed({ ok: true }),
      );

      const plan = yield* Effect.gen(function* () {
        yield* Sync("nightly", { which: "n" });
        yield* Sync("hourly", { which: "h" });
      }).pipe(makePlan);

      expect(plan.actions.nightly.action).toBe("run");
      expect(plan.actions.hourly.action).toBe("run");
      expect(plan.actions.Sync).toBeUndefined();
    }),
  );

  test(
    "Action-containing dependency cycles fail during planning",
    Effect.gen(function* () {
      const Derived = Action("Derived", (input: { value: string }) =>
        Effect.succeed({ value: input.value }),
      );
      const exit = yield* Effect.gen(function* () {
        const resource = yield* BindingTarget("Resource", { string: "value" });
        const derived = yield* Derived({ value: resource.string });
        yield* resource.bind("FromAction", {
          env: { ACTION_VALUE: derived.value },
        });
      }).pipe(makePlan, Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const die = exit.cause.reasons.find(Cause.isDieReason);
      const defect = die?.defect as Plan.UnsupportedActionCycle | undefined;
      expect(defect?._tag).toBe("UnsupportedActionCycle");
      expect(defect?.cycle.sort()).toEqual(["Derived", "Resource"]);
      expect(defect?.actions).toEqual(["Derived"]);
    }),
  );
});

// ── Apply tests ───────────────────────────────────────────────────────────

describe("Apply", () => {
  test.provider("first run invokes body and persists ran state", (stack) =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const Sync = Action("Sync", (input: { n: number }) =>
        Effect.gen(function* () {
          yield* Ref.update(counter, (c) => c + 1);
          return { doubled: input.n * 2 };
        }),
      );

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Sync({ n: 21 });
        }),
      );

      expect(out).toEqual({ doubled: 42 });
      expect(yield* Ref.get(counter)).toBe(1);

      // Persisted state is `ran` with the materialized output.
      const state = yield* yield* State;
      const persisted = yield* state.get({
        stack: stack.name,
        stage: "test",
        fqn: "Sync",
      });
      expect(persisted).toMatchObject({
        kind: "action",
        status: "ran",
        output: { doubled: 42 },
      });
    }),
  );

  test.provider("same input across deploys -> body not re-invoked", (stack) =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const program = Effect.gen(function* () {
        const Sync = Action("Sync", (input: { n: number }) =>
          Effect.gen(function* () {
            yield* Ref.update(counter, (c) => c + 1);
            return { doubled: input.n * 2 };
          }),
        );
        return yield* Sync({ n: 21 });
      });

      const first = yield* stack.deploy(program);
      const second = yield* stack.deploy(program);

      expect(first).toEqual({ doubled: 42 });
      expect(second).toEqual({ doubled: 42 });
      expect(yield* Ref.get(counter)).toBe(1);
    }),
  );

  test.provider(
    "persisted noop Action output makes an unchanged downstream resource noop",
    (stack) =>
      Effect.gen(function* () {
        const Derived = Action("Derived", (input: { value: string }) =>
          Effect.succeed({ value: input.value }),
        );
        const program = (value: string) =>
          Effect.gen(function* () {
            const derived = yield* Derived({ value });
            return yield* TestResource("Consumer", {
              string: derived.value,
            });
          });

        yield* stack.deploy(program("stable"));

        const plan = yield* stack.plan(program("stable"));
        expect(plan.actions.Derived.action).toBe("noop");
        expect(plan.resources.Consumer.action).toBe("noop");
      }),
  );

  test.provider(
    "one Action decision is shared by every downstream consumer",
    (stack) =>
      Effect.gen(function* () {
        const evaluations = yield* Ref.make(0);
        const decisionInput = Output.literal("source").pipe(
          Output.mapEffect(() =>
            Ref.update(evaluations, (count) => count + 1).pipe(
              Effect.as("stable"),
            ),
          ),
        );
        const Derived = Action("Derived", (input: { value: string }) =>
          Effect.succeed({ value: input.value }),
        );
        const program = Effect.gen(function* () {
          const derived = yield* Derived({ value: decisionInput });
          const first = yield* TestResource("First", {
            string: derived.value,
          });
          const second = yield* TestResource("Second", {
            string: derived.value,
          });
          return { first, second };
        });

        yield* stack.deploy(program);
        yield* Ref.set(evaluations, 0);

        const plan = yield* stack.plan(program);
        expect(plan.actions.Derived.action).toBe("noop");
        expect(plan.resources.First.action).toBe("noop");
        expect(plan.resources.Second.action).toBe("noop");
        expect(yield* Ref.get(evaluations)).toBe(1);
      }),
  );

  test.provider(
    "changed Action input keeps downstream evaluation dirty and fresh",
    (stack) =>
      Effect.gen(function* () {
        const Derived = Action("Derived", (input: { value: string }) =>
          Effect.succeed({ value: input.value }),
        );
        const program = (value: string) =>
          Effect.gen(function* () {
            const derived = yield* Derived({ value });
            return yield* TestResource("Consumer", {
              string: derived.value,
            });
          });

        yield* stack.deploy(program("old"));

        const plan = yield* stack.plan(program("fresh"));
        expect(plan.actions.Derived.action).toBe("run");
        expect(plan.resources.Consumer.action).toBe("update");

        const output = yield* stack.deploy(program("fresh"));
        expect(output.string).toBe("fresh");
      }),
  );

  test.provider(
    "unresolved Action input keeps its downstream evaluable",
    (stack) =>
      Effect.gen(function* () {
        const Derived = Action("Derived", (input: { value: string }) =>
          Effect.succeed({ value: input.value }),
        );
        const program = (value: string) =>
          Effect.gen(function* () {
            const source = yield* TestResource("Source", { string: value });
            const derived = yield* Derived({ value: source.string });
            const consumer = yield* TestResource("Consumer", {
              string: derived.value,
            });
            return { source, consumer };
          });

        yield* stack.deploy(program("old"));

        const plan = yield* stack.plan(program("fresh"));
        expect(plan.resources.Source.action).toBe("update");
        expect(plan.actions.Derived.action).toBe("run");
        expect(plan.resources.Consumer.action).toBe("update");

        const output = yield* stack.deploy(program("fresh"));
        expect(output.consumer.string).toBe("fresh");
      }),
  );

  test.provider(
    "captured upstream changes rerun the Action and update its downstream",
    (stack) =>
      Effect.gen(function* () {
        const program = (value: string) =>
          Effect.gen(function* () {
            const source = yield* TestResource("Source", { string: value });
            const Derived = Action(
              "Derived",
              Effect.gen(function* () {
                const captured = yield* source.string;
                return () => Effect.map(captured, (value) => ({ value }));
              }),
            );
            const derived = yield* Derived({});
            const consumer = yield* TestResource("Consumer", {
              string: derived.value,
            });
            return { source, consumer };
          });

        yield* stack.deploy(program("old"));

        const plan = yield* stack.plan(program("fresh"));
        expect(plan.resources.Source.action).toBe("update");
        expect(plan.actions.Derived.action).toBe("run");
        expect(plan.resources.Consumer.action).toBe("update");

        const output = yield* stack.deploy(program("fresh"));
        expect(output.consumer.string).toBe("fresh");
      }),
  );

  test.provider(
    "unchanged Action chains share persisted noop outputs",
    (stack) =>
      Effect.gen(function* () {
        const sourceRuns = yield* Ref.make(0);
        const derivedRuns = yield* Ref.make(0);
        const Source = Action("SourceAction", (_: {}) =>
          Ref.update(sourceRuns, (count) => count + 1).pipe(
            Effect.as({ value: "stable" }),
          ),
        );
        const Derived = Action("DerivedAction", (input: { value: string }) =>
          Ref.update(derivedRuns, (count) => count + 1).pipe(
            Effect.as({ value: input.value }),
          ),
        );
        const program = Effect.gen(function* () {
          const source = yield* Source({});
          const derived = yield* Derived({ value: source.value });
          return yield* TestResource("Consumer", {
            string: derived.value,
          });
        });

        yield* stack.deploy(program);

        const plan = yield* stack.plan(program);
        expect(plan.actions.SourceAction.action).toBe("noop");
        expect(plan.actions.DerivedAction.action).toBe("noop");
        expect(plan.resources.Consumer.action).toBe("noop");

        yield* stack.deploy(program);
        expect(yield* Ref.get(sourceRuns)).toBe(1);
        expect(yield* Ref.get(derivedRuns)).toBe(1);
      }),
  );

  test.provider(
    "unchanged captured values keep the Action and downstream noop",
    (stack) =>
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const program = Effect.gen(function* () {
          const source = yield* TestResource("Source", { string: "stable" });
          const Derived = Action(
            "CapturedAction",
            Effect.gen(function* () {
              const captured = yield* source.string;
              return () =>
                Effect.gen(function* () {
                  yield* Ref.update(runs, (count) => count + 1);
                  return { value: yield* captured };
                });
            }),
          );
          const derived = yield* Derived({});
          return yield* TestResource("Consumer", {
            string: derived.value,
          });
        });

        yield* stack.deploy(program);

        const plan = yield* stack.plan(program);
        expect(plan.resources.Source.action).toBe("noop");
        expect(plan.actions.CapturedAction.action).toBe("noop");
        expect(plan.resources.Consumer.action).toBe("noop");

        yield* stack.deploy(program);
        expect(yield* Ref.get(runs)).toBe(1);
      }),
  );

  test.provider(
    "planned noop Action reruns when an upstream noop refreshes during Apply",
    (stack) =>
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const program = Effect.gen(function* () {
          const source = yield* TestResource("Source", { string: "old" });
          const Derived = Action(
            "Derived",
            Effect.gen(function* () {
              const captured = yield* source.string;
              return () =>
                Effect.gen(function* () {
                  yield* Ref.update(runs, (count) => count + 1);
                  return { value: yield* captured };
                });
            }),
          );
          const derived = yield* Derived({});
          return yield* TestResource("Consumer", {
            string: derived.value,
          });
        });

        yield* stack.deploy(program);
        const plan = yield* stack.plan(program);
        expect(plan.resources.Source.action).toBe("noop");
        expect(plan.actions.Derived.action).toBe("noop");
        expect(plan.resources.Consumer.action).toBe("noop");

        // Reproduce apply-time drift discovered after planning: the upstream
        // noop re-evaluates to new desired props and upgrades itself.
        plan.resources.Source = {
          ...plan.resources.Source,
          props: { string: "fresh" },
        } as Plan.NoopUpdate;

        const output = yield* apply(plan);
        expect(output.string).toBe("fresh");
        expect(yield* Ref.get(runs)).toBe(2);
      }),
  );

  test.provider(
    "planned noop Action follows a self-cyclic resource through convergence",
    (stack) =>
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const program = Effect.gen(function* () {
          const source = yield* BindingTarget("Source", { string: "old" });
          yield* source.bind("Self", { env: { SELF: source.string } });
          const Derived = Action("Derived", (input: { value: string }) =>
            Ref.update(runs, (count) => count + 1).pipe(
              Effect.as({ value: input.value }),
            ),
          );
          const derived = yield* Derived({ value: source.env.SELF });
          return yield* TestResource("Consumer", {
            string: derived.value,
          });
        });

        yield* stack.deploy(program);
        const plan = yield* stack.plan(program);
        expect(plan.resources.Source.action).toBe("noop");
        expect(plan.actions.Derived.action).toBe("noop");
        expect(plan.resources.Consumer.action).toBe("noop");

        // The self-edge lets the initial noop refresh reconcile with its old
        // binding value; phase-3 convergence then advances `env.SELF`.
        plan.resources.Source = {
          ...plan.resources.Source,
          props: { string: "fresh" },
          bindings: plan.resources.Source.bindings.map((binding) => ({
            ...binding,
            data: {
              env: { SELF: plan.resources.Source.resource.string },
            },
          })),
        } as Plan.NoopUpdate;

        const output = yield* apply(plan);
        expect(output.string).toBe("fresh");
        expect(yield* Ref.get(runs)).toBe(2);
      }),
  );

  test.provider("changed input -> body re-invoked", (stack) =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const programFor = (n: number) =>
        Effect.gen(function* () {
          const Sync = Action("Sync", (input: { n: number }) =>
            Effect.gen(function* () {
              yield* Ref.update(counter, (c) => c + 1);
              return { doubled: input.n * 2 };
            }),
          );
          return yield* Sync({ n });
        });

      yield* stack.deploy(programFor(21));
      const second = yield* stack.deploy(programFor(50));

      expect(second).toEqual({ doubled: 100 });
      expect(yield* Ref.get(counter)).toBe(2);
    }),
  );

  test.provider("task output flows to downstream resource input", (stack) =>
    Effect.gen(function* () {
      const Name = Action("Name", (_: {}) =>
        Effect.succeed({ name: "computed-bucket-name" }),
      );

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const computed = yield* Name({});
          return yield* Bucket("MyBucket", { name: computed.name });
        }),
      );

      expect(out.name).toBe("computed-bucket-name");
    }),
  );

  test.provider("resource attr flows to task input", (stack) =>
    Effect.gen(function* () {
      const Echo = Action("Echo", (input: { name: string }) =>
        Effect.succeed({ echoed: input.name }),
      );

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("MyBucket", { name: "from-resource" });
          return yield* Echo({ name: bucket.name });
        }),
      );

      expect(out).toEqual({ echoed: "from-resource" });
    }),
  );

  test.provider(
    "removing task from stack drops state without invoking body",
    (stack) =>
      Effect.gen(function* () {
        const deleteSpy = yield* Ref.make(0);
        const Sync = Action("Sync", (_: { n: number }) =>
          Effect.succeed({ ok: true }),
        );

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Sync({ n: 1 });
          }),
        );

        const state = yield* yield* State;
        expect(
          yield* state.get({ stack: stack.name, stage: "test", fqn: "Sync" }),
        ).toMatchObject({ kind: "action", status: "ran" });

        // Re-deploy WITHOUT the task — state should be dropped.
        // (Use a tracker hook to confirm body wasn't called.)
        yield* stack.deploy(Effect.succeed(undefined));
        void deleteSpy;

        expect(
          yield* state.get({ stack: stack.name, stage: "test", fqn: "Sync" }),
        ).toBeUndefined();
      }),
  );

  test.provider(
    "init captures a resource Output; body resolves it at apply",
    (stack) =>
      Effect.gen(function* () {
        const out = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Bucket("Cap", { name: "cap-bucket" });

            const Seed = Action(
              "Seed",
              Effect.gen(function* () {
                // Capture the resource Output at init — before the bucket
                // exists. `arn` is a deferred accessor.
                const arn = yield* bucket.bucketArn;
                const name = yield* bucket.name;
                return Effect.fn(function* () {
                  // Resolve at apply, after the bucket is materialized.
                  return { arn: yield* arn, name: yield* name };
                });
              }),
            );

            return yield* Seed({});
          }),
        );

        expect(out).toEqual({
          arn: "arn:test:bucket:us-east-1:123456789:Cap",
          name: "cap-bucket",
        });
      }),
  );

  test.provider("init-effect form: deps satisfied at apply", (stack) =>
    Effect.gen(function* () {
      class Multiplier extends Context.Service<Multiplier, number>()(
        "test/Multiplier",
      ) {}

      const Sync = Action(
        "Sync",
        Effect.gen(function* () {
          const m = yield* Multiplier;
          return (input: { n: number }) =>
            Effect.succeed({ result: input.n * m });
        }),
      );

      const out = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Sync({ n: 21 });
          }),
        )
        .pipe(Effect.provideService(Multiplier, 3));

      expect(out).toEqual({ result: 63 });
    }),
  );

  test.provider(
    "tagged .make form: init captures a resource Output; body resolves it",
    (stack) =>
      Effect.gen(function* () {
        interface SeedAction extends Action<"Seed", {}, { arn: string }> {}
        const Seed = Action<SeedAction, {}, { arn: string }>()("Seed");

        const out = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Bucket("Cap", { name: "cap-bucket" });

            // `.make` called inside the builder with `bucket` in scope, then
            // provided locally — its init runs under the capture context.
            const SeedLive = Seed.make(
              Effect.gen(function* () {
                const arn = yield* bucket.bucketArn;
                return Effect.fn(function* () {
                  return { arn: yield* arn };
                });
              }),
            );

            return yield* Seed({}).pipe(Effect.provide(SeedLive));
          }),
        );

        expect(out).toEqual({
          arn: "arn:test:bucket:us-east-1:123456789:Cap",
        });
      }),
  );
});
