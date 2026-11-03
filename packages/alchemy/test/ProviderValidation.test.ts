import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { isResolved } from "@/Diff";
import * as Provider from "@/Provider";
import { Resource } from "@/Resource";
import { inMemoryState } from "@/State";

interface Validated extends Resource<"Test.Validated", { invalid: boolean }, { name: string }> {}
const Validated = Resource<Validated>("Test.Validated");
let writes = 0;
const observations: boolean[] = [];
const { test } = Test.make({
  state: inMemoryState(),
  providers: Provider.succeed(Validated, {
    validate: ({ news, output }) =>
      Effect.sync(() => {
        observations.push(output !== undefined);
        if (isResolved(news) && news.invalid) throw new Error("invalid planned resource");
      }),
    reconcile: ({ id }) =>
      Effect.sync(() => {
        writes++;
        return { name: id };
      }),
    delete: () => Effect.void,
  }),
});
test.provider("validates first creates, noops and updates before writes", (stack) =>
  Effect.gen(function* () {
    writes = 0;
    observations.length = 0;
    const program = (invalid: boolean) => Validated("validated", { invalid });
    expect(Exit.isFailure(yield* Effect.exit(stack.plan(program(true))))).toBe(true);
    expect(writes).toBe(0);
    yield* stack.deploy(program(false));
    expect(writes).toBe(1);
    yield* stack.plan(program(false));
    expect(Exit.isFailure(yield* Effect.exit(stack.plan(program(true))))).toBe(true);
    expect(writes).toBe(1);
    expect(observations).toContain(false);
    expect(observations).toContain(true);
    yield* stack.destroy();
  }),
);
