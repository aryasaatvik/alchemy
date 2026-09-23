import {
  CloudflareEnvironment,
  fromEnv,
  runtimeIdentity,
  runtimeIdentityLayer,
} from "@/Cloudflare/CloudflareEnvironment.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

describe("Cloudflare runtime identity", () => {
  it.effect(
    "materializes the configured account id with the runtime shape",
    () =>
      Effect.gen(function* () {
        const environment = yield* yield* CloudflareEnvironment;
        expect(environment).toEqual(runtimeIdentity("account-id"));
        expect(environment.accountId).toBe("account-id");
      }).pipe(
        Effect.provide(fromEnv()),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ CLOUDFLARE_ACCOUNT_ID: "account-id" }),
        ),
      ),
  );

  it.effect("a runtime host exposes the injected account id", () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      expect(accountId).toBe("account-123");
    }).pipe(Effect.provide(runtimeIdentityLayer("account-123"))),
  );

  it.effect("a runtime host without an account dies only on use", () =>
    Effect.gen(function* () {
      const environment = yield* CloudflareEnvironment;
      const exit = yield* Effect.exit(environment);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(runtimeIdentityLayer(undefined))),
  );
});
