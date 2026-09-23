import { stackConstant, stackFromEnv } from "@/Runtime/Bootstrap/Process.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

const readIdentity = Effect.gen(function* () {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return { name: stack.name, stackStage: stack.stage, stage };
});

describe("packaged bootstrap identity", () => {
  it.effect("a baked-in stack also provides its Stage", () =>
    readIdentity.pipe(
      Effect.provide(stackConstant("samva", "local")),
      Effect.tap((identity) =>
        Effect.sync(() =>
          expect(identity).toEqual({
            name: "samva",
            stackStage: "local",
            stage: "local",
          }),
        ),
      ),
    ),
  );

  it.effect("an injected stack also provides its Stage", () =>
    readIdentity.pipe(
      Effect.provide(stackFromEnv),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ALCHEMY_STACK_NAME: "samva",
          ALCHEMY_STAGE: "production",
        }),
      ),
      Effect.tap((identity) =>
        Effect.sync(() =>
          expect(identity).toEqual({
            name: "samva",
            stackStage: "production",
            stage: "production",
          }),
        ),
      ),
    ),
  );
});
