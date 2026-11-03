import {
  CloudflareEnvironment,
  runtimeIdentity,
  runtimeIdentityLayer,
} from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

describe("Cloudflare runtime identity", () => {
  it.effect("a runtime host exposes the injected account id", () =>
    Effect.gen(function* () {
      const environment = yield* yield* CloudflareEnvironment;
      expect(environment).toEqual(runtimeIdentity("account-123"));
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
