import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";
import { immutableRun } from "@/Bundle/Bundle.ts";
import { exec } from "@/Util/exec.ts";
import { nodeLoaderArgs } from "@/Util/Node.ts";

describe("immutable compiler", { tags: ["unit", "local"] }, () => {
  it.effect("is opt-in and rejects invalid switch values", () =>
    Effect.gen(function* () {
      expect(
        yield* immutableRun.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        ),
      ).toBe(false);
      expect(
        yield* immutableRun.pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ ALCHEMY_DEV_IMMUTABLE: "true" })),
          ),
        ),
      ).toBe(true);
      const invalid = yield* Effect.result(
        immutableRun.pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ ALCHEMY_DEV_IMMUTABLE: "invalid" })),
          ),
        ),
      );
      expect(invalid._tag).toBe("Failure");
    }),
  );

  for (const runtime of ["bun", "node"]) {
    it.effect(
      `${runtime}: builds in bounded workers and reaps success, failure and interruption`,
      () => {
        const probe = fileURLToPath(new URL("./fixtures/isolated-build-probe.ts", import.meta.url));
        return Effect.gen(function* () {
          const result = yield* exec(
            ChildProcess.make(
              runtime,
              [...(runtime === "node" ? nodeLoaderArgs(probe) : ["run"]), probe],
              {
                env: { ALCHEMY_BUNDLE_CONCURRENCY: "1" },
                extendEnv: true,
              },
            ),
          );
          expect({ code: result.exitCode, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
          expect(result.stdout).toContain('"peak":1,"nativeLoads":0');
          expect(result.stdout).toContain("RESULT ");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
      },
      { timeout: 60_000 },
    );
  }
});
