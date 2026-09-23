import { AWSEnvironment } from "@/AWS/Environment.ts";
import { lambdaAWSEnvironment } from "@/Runtime/Bootstrap/Lambda.ts";
import { stackConstant, stackFromEnv } from "@/Runtime/Bootstrap/Process.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

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

describe("packaged Lambda AWS environment", () => {
  it.effect("uses the injected account id without calling STS", () => {
    let requests = 0;
    const offline = HttpClient.make(() =>
      Effect.die(new Error(`unexpected AWS request #${++requests}`)),
    );
    return Effect.gen(function* () {
      const environment = yield* yield* AWSEnvironment;
      expect(environment.accountId).toBe("654654387918");
      expect(environment.region).toBe("ap-south-1");
      expect(requests).toBe(0);
    }).pipe(
      Effect.provide(lambdaAWSEnvironment),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, offline)),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ALCHEMY_AWS_ACCOUNT_ID: "654654387918",
          AWS_REGION: "ap-south-1",
        }),
      ),
    );
  });
});
