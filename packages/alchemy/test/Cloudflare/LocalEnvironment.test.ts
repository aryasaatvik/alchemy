import { AuthProviders } from "@/Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "@/Auth/Credentials.ts";
import { ProfileLive } from "@/Auth/Profile.ts";
import {
  CloudflareEnvironment,
  runtimeIdentity,
} from "@/Cloudflare/CloudflareEnvironment.ts";
import {
  LiveCloudflareEnvironment,
  LOCAL_CLOUDFLARE_ACCOUNT_ID,
  provideLocalEnvironment,
  resolveLiveEnvironment,
  retainedLiveEnvironment,
} from "@/Cloudflare/LocalEnvironment.ts";
import { hasRemoteRuntimeBindings } from "@/Cloudflare/Workers/RuntimeBindings.ts";
import * as Provider from "@/Provider.ts";
import { Resource } from "@/Resource.ts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface LocalIdentityResource extends Resource<
  "Cloudflare.LocalIdentity.Test",
  {},
  { accountId: string }
> {}

const LocalIdentityResource = Resource<LocalIdentityResource>(
  "Cloudflare.LocalIdentity.Test",
);

const localIdentityProvider = Provider.succeed(LocalIdentityResource, {
  list: () =>
    Effect.gen(function* () {
      const environment = yield* CloudflareEnvironment;
      const { accountId } = yield* environment;
      return [{ accountId }];
    }),
  reconcile: () => Effect.die("not used"),
  delete: () => Effect.void,
});

describe("Cloudflare local environment", () => {
  it.effect(
    "constructs local providers without evaluating live identity",
    () => {
      let liveReads = 0;
      const liveEnvironment = Layer.succeed(
        CloudflareEnvironment,
        Effect.sync(() => {
          liveReads += 1;
          return runtimeIdentity("live-account");
        }),
      );

      return Effect.gen(function* () {
        const provider = yield* Provider.findProvider(LocalIdentityResource);

        expect(yield* provider.list()).toEqual([
          { accountId: LOCAL_CLOUDFLARE_ACCOUNT_ID },
        ]);
        expect(liveReads).toBe(0);
      }).pipe(
        Effect.provide(
          provideLocalEnvironment(localIdentityProvider).pipe(
            Layer.provide(liveEnvironment),
          ),
        ),
      );
    },
  );

  it.effect("retains profile identity without resolving authentication", () =>
    Effect.gen(function* () {
      const environment = yield* LiveCloudflareEnvironment;

      expect(Effect.isEffect(environment)).toBe(true);
    }).pipe(
      Effect.provide(retainedLiveEnvironment),
      Effect.provide(ProfileLive),
      Effect.provide(CredentialsStoreLive),
      Effect.provideService(AuthProviders, {}),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("resolves live identity only for an explicit remote bridge", () => {
    let liveReads = 0;

    return Effect.gen(function* () {
      expect(liveReads).toBe(0);
      expect((yield* resolveLiveEnvironment).accountId).toBe("live-account");
      expect(liveReads).toBe(1);
    }).pipe(
      Effect.provideService(
        LiveCloudflareEnvironment,
        Effect.sync(() => {
          liveReads += 1;
          return runtimeIdentity("live-account");
        }),
      ),
    );
  });

  it("requires live identity only for remote runtime bindings", () => {
    expect(
      hasRemoteRuntimeBindings([
        { type: "plain_text", name: "VALUE", text: "local" },
        { type: "kv_namespace", name: "KV", namespaceId: "dev:kv" },
      ]),
    ).toBe(false);
    expect(
      hasRemoteRuntimeBindings([{ type: "browser", name: "BROWSER" }], {
        BROWSER: true,
      }),
    ).toBe(true);
    expect(
      hasRemoteRuntimeBindings([
        { type: "kv_namespace", name: "KV", namespaceId: "live-kv" },
      ]),
    ).toBe(true);
  });
});
