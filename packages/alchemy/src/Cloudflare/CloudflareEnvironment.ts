import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  type CloudflareAuthConfig,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthConfig.ts";

import {
  CloudflareEnvironment,
  type CloudflareEnvironmentShape,
  type CloudflareRuntimeIdentity,
} from "./CloudflareEnvironmentService.ts";

export { CloudflareEnvironment } from "./CloudflareEnvironmentService.ts";
export type { CloudflareEnvironmentShape, CloudflareRuntimeIdentity };

export const runtimeIdentity = (
  accountId: string,
): CloudflareRuntimeIdentity => ({
  type: "runtime",
  accountId,
  source: { type: "runtime" },
});

const CLOUDFLARE_ACCOUNT_ID = Config.String("CLOUDFLARE_ACCOUNT_ID");

export const fromEnv = () =>
  Layer.effect(
    CloudflareEnvironment,
    CLOUDFLARE_ACCOUNT_ID.pipe(
      Effect.map(runtimeIdentity),
      Effect.orDie,
      Effect.cached,
    ),
  );

export const fromProfile = () =>
  Layer.effect(
    CloudflareEnvironment,
    Effect.gen(function* () {
      // In CI this resolves directly from environment variables. Otherwise it
      // reads the persisted config under the canonical provider name and only
      // configures/persists when no local config exists.
      const { resolve } = yield* resolveProviderConfig<
        CloudflareAuthConfig,
        CloudflareResolvedCredentials
      >(CLOUDFLARE_AUTH_PROVIDER_NAME);
      return yield* resolve.pipe(Effect.orDie, Effect.cached);
    }),
  );
