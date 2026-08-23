import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { CredentialsStore } from "../Auth/Credentials.ts";
import { AlchemyProfile } from "../Auth/Profile.ts";
import { provideProviderContext } from "../Local/ProviderContext.ts";
import { LOCAL_ID_PREFIX } from "../ProviderMode.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";

/**
 * Stable account identity for Cloudflare resources emulated by `alchemy dev`.
 *
 * Local providers need an account-shaped namespace for resource attributes and
 * workerd bindings, but they must not resolve the active Cloudflare profile or
 * deployment credentials. Real resources selected with `Alchemy.remote()` keep
 * using the live environment supplied by `Cloudflare.providers()`.
 */
export const LOCAL_CLOUDFLARE_ACCOUNT_ID = `${LOCAL_ID_PREFIX}cloudflare-account`;

export const localEnvironment = Layer.succeed(
  CloudflareEnvironment.CloudflareEnvironment,
  Effect.succeed(
    CloudflareEnvironment.runtimeIdentity(LOCAL_CLOUDFLARE_ACCOUNT_ID),
  ),
);

/**
 * Resolve the live account identity only when a remote local binding actually
 * needs it.
 *
 * Keeping the profile layer inside this Effect is the important boundary: a
 * local sidecar or Vite child can retain the operation without constructing a
 * profile at startup. The remote-binding bridge is the sole evaluator.
 */
export const liveEnvironmentFromProfile = Effect.flatten(
  CloudflareEnvironment.CloudflareEnvironment,
).pipe(
  Effect.provide(
    CloudflareEnvironment.fromProfile().pipe(Layer.provide(CloudflareAuth)),
  ),
);

/**
 * The live environment retained alongside the synthetic local identity.
 *
 * Hybrid local providers use this only when a local resource explicitly
 * bridges to an `Alchemy.remote()` dependency. Merely constructing or using a
 * purely local provider never evaluates the retained live environment effect.
 */
export class LiveCloudflareEnvironment extends Context.Service<
  LiveCloudflareEnvironment,
  CloudflareEnvironment.CloudflareEnvironment["Service"]
>()("Cloudflare::LiveCloudflareEnvironment") {}

export const retainedLiveEnvironment = Layer.effect(
  LiveCloudflareEnvironment,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      AlchemyProfile | AuthProviders | CredentialsStore
    >();
    return liveEnvironmentFromProfile.pipe(
      Effect.provide(context),
      Effect.orDie,
    );
  }),
);

/** Run a provider's construction and lifecycle under the local identity. */
export const provideLocalEnvironment = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  provideProviderContext(layer, localEnvironment);
