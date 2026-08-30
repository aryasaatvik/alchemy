import {
  CloudflareEnvironment,
  fromEnv,
  runtimeIdentity,
} from "@/Cloudflare/CloudflareEnvironment.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

describe("Cloudflare runtime identity", () => {
  it.effect(
    "materializes the configured account id with the runtime shape",
    () =>
      Effect.gen(function* () {
        const environment = yield* CloudflareEnvironment;
        expect(yield* environment).toEqual(runtimeIdentity("account-id"));
      }).pipe(
        Effect.provide(fromEnv()),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ CLOUDFLARE_ACCOUNT_ID: "account-id" }),
        ),
      ),
  );
});
