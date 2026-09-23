import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CloudflareResolvedCredentials } from "./Auth/AuthConfig.ts";

/**
 * Account-only identity available inside deployed and local application
 * runtimes (Workers, Containers, Lambdas). Runtimes never carry the
 * deployer's credentials, only the account the stack was deployed into.
 */
export interface CloudflareRuntimeIdentity {
  readonly type: "runtime";
  readonly accountId: string;
  readonly source: { readonly type: "runtime" };
}

/** Build the {@link CloudflareRuntimeIdentity} for an account. */
export const runtimeIdentity = (
  accountId: string,
): CloudflareRuntimeIdentity => ({
  type: "runtime",
  accountId,
  source: { type: "runtime" },
});

export type CloudflareEnvironmentShape =
  | CloudflareResolvedCredentials
  | CloudflareRuntimeIdentity;

export class CloudflareEnvironment extends Context.Service<
  CloudflareEnvironment,
  Effect.Effect<CloudflareEnvironmentShape>
>()("Cloudflare::CloudflareEnvironment") {
  readonly kind = "Environment" as const;
}

/**
 * Provide {@link CloudflareEnvironment} inside an application runtime from the
 * `ALCHEMY_CLOUDFLARE_ACCOUNT_ID` the host injected. When the host injected no
 * account, the service still exists but dies on first use, so programs that
 * never touch Cloudflare boot unaffected.
 */
export const runtimeIdentityLayer = (
  accountId: string | undefined,
): Layer.Layer<CloudflareEnvironment> =>
  Layer.succeed(
    CloudflareEnvironment,
    accountId === undefined || accountId === ""
      ? Effect.die(
          new Error(
            "ALCHEMY_CLOUDFLARE_ACCOUNT_ID is not set in this runtime; the " +
              "deployed host did not carry a Cloudflare account identity.",
          ),
        )
      : Effect.succeed(runtimeIdentity(accountId)),
  );
