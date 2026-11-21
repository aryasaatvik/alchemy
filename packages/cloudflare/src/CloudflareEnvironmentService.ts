import * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
export const runtimeIdentity = (accountId: string): CloudflareRuntimeIdentity => ({
  type: "runtime",
  accountId,
  source: { type: "runtime" },
});

export type CloudflareEnvironmentShape = CloudflareResolvedCredentials | CloudflareRuntimeIdentity;

const identityEnvKey = "ALCHEMY_CLOUDFLARE_ACCOUNT_ID";

const requireRuntimeAccount = (accountId: string | undefined): string => {
  if (!accountId?.trim()) {
    throw new Error(`${identityEnvKey} is required for a Lambda's Cloudflare binding`);
  }
  return accountId;
};

/** Carry the scoped token's account output to the Lambda that binds it. */
export const bindLambdaRuntimeAccount = (account: Output.Output<string, never>) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    const host = yield* CurrentRuntimeContext;
    if (host?.Type === "AWS.Lambda.Function" || host?.Type === "AWS.Lambda.WebFunction") {
      yield* host.set(identityEnvKey, account.pipe(Output.map(requireRuntimeAccount)));
    }
  });

export class CloudflareEnvironment extends Context.Service<
  CloudflareEnvironment,
  Effect.Effect<CloudflareEnvironmentShape>
>()("Cloudflare::CloudflareEnvironment") {
  /** Resolve the deploy environment or the account injected by a runtime binding. */
  static current = Effect.gen(function* () {
    const provided = yield* Effect.serviceOption(CloudflareEnvironment);
    if (Option.isSome(provided)) return yield* provided.value;
    if (globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* CurrentRuntimeContext;
      const accountId = host
        ? yield* host.get<string>(identityEnvKey)
        : yield* Config.String(identityEnvKey).pipe(
            Config.option,
            Effect.map(Option.getOrUndefined),
            Effect.orDie,
          );
      return runtimeIdentity(requireRuntimeAccount(accountId));
    }
    return yield* yield* CloudflareEnvironment;
  }) as Effect.Effect<CloudflareEnvironmentShape>;
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
