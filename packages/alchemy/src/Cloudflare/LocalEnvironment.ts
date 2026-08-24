import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { CredentialsStore } from "../Auth/Credentials.ts";
import { AlchemyProfile } from "../Auth/Profile.ts";
import { provideProviderContext } from "../Local/ProviderContext.ts";
import { LOCAL_ID_PREFIX } from "../ProviderMode.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";

/** Stable account namespace for resources emulated by `alchemy dev`. */
export const LOCAL_CLOUDFLARE_ACCOUNT_ID = `${LOCAL_ID_PREFIX}cloudflare-account`;

export const localEnvironment = Layer.succeed(
  CloudflareEnvironment.CloudflareEnvironment,
  Effect.succeed(
    CloudflareEnvironment.runtimeIdentity(LOCAL_CLOUDFLARE_ACCOUNT_ID),
  ),
);

/** Build the live profile layer only when a remote local bridge needs it. */
export const liveEnvironmentFromProfile = Effect.flatten(
  CloudflareEnvironment.CloudflareEnvironment,
).pipe(
  Effect.provide(
    CloudflareEnvironment.fromProfile().pipe(Layer.provide(CloudflareAuth)),
  ),
);

/** Live identity retained as an unevaluated effect beside the local identity. */
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

/** Resolve retained live identity only when a local resource bridges remotely. */
export const resolveLiveEnvironment: Effect.Effect<CloudflareEnvironment.CloudflareEnvironmentShape> =
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const environment = Context.getOption(context, LiveCloudflareEnvironment);
    return yield* Option.match(environment, {
      onNone: () =>
        Effect.die(
          new Error(
            "Live Cloudflare environment is unavailable for this remote local bridge",
          ),
        ),
      onSome: (environment) => environment,
    });
  });

/** Build and execute a local provider under the synthetic account identity. */
export const provideLocalEnvironment = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  provideProviderContext(layer, localEnvironment);
