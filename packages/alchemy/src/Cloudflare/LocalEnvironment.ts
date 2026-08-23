import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { provideProviderContext } from "../Local/ProviderContext.ts";
import { LOCAL_ID_PREFIX } from "../ProviderMode.ts";
import {
  CloudflareEnvironment,
  runtimeIdentity,
} from "./CloudflareEnvironment.ts";

/**
 * Stable account identity for Cloudflare resources emulated by `alchemy dev`.
 *
 * Local providers need an account-shaped namespace for resource attributes and
 * workerd bindings, but they must not resolve the active Cloudflare profile or
 * deployment credentials. Real resources selected with `Alchemy.remote()` keep
 * using the live environment supplied by `Cloudflare.providers()`.
 */
export const LOCAL_CLOUDFLARE_ACCOUNT_ID = `${LOCAL_ID_PREFIX}cloudflare-account`;

const localEnvironment = Layer.succeed(
  CloudflareEnvironment,
  Effect.succeed(runtimeIdentity(LOCAL_CLOUDFLARE_ACCOUNT_ID)),
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
  CloudflareEnvironment["Service"]
>()("Cloudflare::LiveCloudflareEnvironment") {}

export const retainedLiveEnvironment = Layer.effect(
  LiveCloudflareEnvironment,
  CloudflareEnvironment,
);

/** Run a provider's construction and lifecycle under the local identity. */
export const provideLocalEnvironment = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  provideProviderContext(layer, localEnvironment);
