import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  type CloudflareAuthConfig,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthProvider.ts";

/**
 * Stable Cloudflare identity available to both deployment providers and
 * generated application runtimes.
 *
 * Authentication is deliberately owned by the separate `Credentials`
 * service. Runtime hosts only need the account identity required to resolve
 * resource-derived configuration; they must not receive Alchemy's deployment
 * credential as an environment variable.
 */
export interface CloudflareRuntimeIdentity {
  readonly type: "runtime";
  readonly accountId: string;
  readonly source: { readonly type: "runtime" };
}

/**
 * The account-only environment available inside a deployed Worker or
 * container. Runtime hosts deliberately receive no deployment credentials.
 */
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

const CLOUDFLARE_ACCOUNT_ID = Config.string("CLOUDFLARE_ACCOUNT_ID");

export const fromEnv = () =>
  Layer.succeed(
    CloudflareEnvironment,
    CLOUDFLARE_ACCOUNT_ID.pipe(
      Effect.map((accountId) => runtimeIdentity(accountId)),
      Effect.orDie,
      Effect.cached,
    ),
  );

export const fromProfile = () =>
  Layer.succeed(
    CloudflareEnvironment,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        CloudflareAuthConfig,
        CloudflareResolvedCredentials
      >(CLOUDFLARE_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      // `loadOrConfigure` reads the persisted config under the canonical
      // provider name (`Cloudflare`); only runs `configure` (and persists the
      // result) if no stored config exists.
      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as CloudflareAuthConfig),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
