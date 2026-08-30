import { buildEventTelemetry } from "@/Telemetry";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

const config = (disabled: boolean) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ALCHEMY_EVENT_TELEMETRY_DISABLED: disabled,
    }),
  );

describe("event telemetry", () => {
  it.effect("builds the configured event telemetry layer by default", () =>
    Effect.gen(function* () {
      let builds = 0;
      const scope = yield* Scope.make();
      const telemetry = Layer.effectDiscard(
        Effect.sync(() => {
          builds += 1;
        }),
      );

      yield* buildEventTelemetry(
        Context.empty(),
        scope,
        telemetry,
        Layer.empty,
      );

      expect(builds).toBe(1);
    }).pipe(Effect.provide(config(false))),
  );

  it.effect("skips only Alchemy event telemetry when explicitly disabled", () =>
    Effect.gen(function* () {
      let builds = 0;
      const scope = yield* Scope.make();
      const telemetry = Layer.effectDiscard(
        Effect.sync(() => {
          builds += 1;
        }),
      );

      yield* buildEventTelemetry(
        Context.empty(),
        scope,
        telemetry,
        Layer.empty,
      );

      expect(builds).toBe(0);
    }).pipe(Effect.provide(config(true))),
  );
});
