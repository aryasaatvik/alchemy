import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { cloudflareRuntimeIdentityLayer } from "@/Runtime/Bootstrap/Lambda.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

it.effect(
  "reconstructs the Cloudflare runtime identity for packaged Lambdas",
  () =>
    Effect.gen(function* () {
      const environment = yield* yield* CloudflareEnvironment;

      expect(environment).toEqual({
        type: "runtime",
        accountId: "account-123",
        source: { type: "runtime" },
      });
    }).pipe(Effect.provide(cloudflareRuntimeIdentityLayer("account-123"))),
);
