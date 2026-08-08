import {
  CloudflareEnvironment,
  fromEnv,
  runtimeIdentity,
} from "@/Cloudflare/CloudflareEnvironment.ts";
import { makeR2HttpScope } from "@/Cloudflare/R2/BucketHttp.ts";
import { makeLocalWorkerStandardBindings } from "@/Cloudflare/Workers/LocalWorkerProvider.ts";
import * as PluginContext from "@alchemy.run/cloudflare-runtime/core/PluginContext";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

describe("Cloudflare runtime identity", () => {
  const accountId = "concrete-account-id";

  it("gives Worker bridge runtime code the typed account identity", () => {
    expect(runtimeIdentity(accountId)).toEqual({
      type: "runtime",
      accountId,
      source: { type: "runtime" },
    });
  });

  it.effect("resolves a concrete identity from the environment layer", () =>
    Effect.gen(function* () {
      const environment = yield* CloudflareEnvironment;
      const identity = yield* environment;

      expect(Effect.isEffect(identity)).toBe(false);
      expect(identity).toEqual({
        type: "runtime",
        accountId,
        source: { type: "runtime" },
      });
    }).pipe(
      Effect.provide(fromEnv()),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ CLOUDFLARE_ACCOUNT_ID: accountId }),
      ),
    ),
  );

  it.effect(
    "emits one concrete account binding and ignores undefined or reserved env entries",
    () =>
      Effect.gen(function* () {
        const hooks = yield* makeLocalWorkerStandardBindings({
          accountId,
          workerName: "worker",
          stackName: "stack",
          stage: "dev",
          env: {
            ALCHEMY_CLOUDFLARE_ACCOUNT_ID: undefined,
            OMITTED: undefined,
            INCLUDED: "value",
          },
          descriptorNames: new Set(),
          selfUrl: undefined,
        });
        const bindings = yield* Effect.all(hooks).pipe(
          Effect.provideService(
            PluginContext.PluginContext,
            yield* PluginContext.make({
              name: "worker",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [],
            }),
          ),
        );
        const accountBindings = bindings.filter(
          (binding) => binding.name === "ALCHEMY_CLOUDFLARE_ACCOUNT_ID",
        );

        expect(accountBindings).toEqual([
          { name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", text: accountId },
        ]);
        expect(bindings.some((binding) => binding.name === "OMITTED")).toBe(
          false,
        );
        expect(bindings).toContainEqual({ name: "INCLUDED", text: "value" });
      }),
  );

  it.effect("rejects a missing local Worker account identity", () =>
    Effect.gen(function* () {
      const error = yield* makeLocalWorkerStandardBindings({
        accountId: undefined as unknown as string,
        workerName: "worker",
        stackName: "stack",
        stage: "dev",
        env: undefined,
        descriptorNames: new Set(),
        selfUrl: undefined,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("WorkerValidationError");
      expect(error.message).toContain("account ID is missing");
    }),
  );

  it.effect(
    "carries the container bootstrap account into an account-scoped HTTP path",
    () =>
      Effect.gen(function* () {
        const identity = runtimeIdentity(accountId);
        const scope = yield* makeR2HttpScope(
          Effect.succeed(identity.accountId),
          Effect.succeed("bucket"),
          Effect.succeed("default"),
        );

        expect(
          new URL(
            `/accounts/${scope.accountId}/r2/buckets/${scope.bucketName}`,
            "https://api.cloudflare.com",
          ).pathname,
        ).toBe("/accounts/concrete-account-id/r2/buckets/bucket");
      }),
  );
});
