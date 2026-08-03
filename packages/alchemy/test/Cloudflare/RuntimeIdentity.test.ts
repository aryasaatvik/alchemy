import { runtimeIdentity } from "@/Cloudflare/CloudflareEnvironment.ts";
import { makeR2HttpScope } from "@/Cloudflare/R2/BucketHttp.ts";
import { describe, expect, it } from "alchemy-test";
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
