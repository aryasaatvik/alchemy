import * as ACME from "@/ACME";
import * as Output from "@/Output";
import * as ZeroSsl from "@distilled.cloud/zerossl";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { StandingZoneResource } from "../../Cloudflare/StandingZone.ts";

/**
 * The standing test zone, bound in the issuing Workers' init phase. The stacks
 * that deploy those Workers resolve it with `requireStandingZone` first, so it
 * is adopted, never created, and retained on destroy.
 */
export const Zone = StandingZoneResource("AcmeZone");

export const Staging = ACME.Account("Staging", {
  ca: ACME.LetsEncryptStaging,
  contact: ["mailto:ops@alchemy.run"],
  termsOfServiceAgreed: true,
});

/**
 * External Account Binding minted from `ZERO_SSL_KEY` when the stack is
 * evaluated. Only `newAccount` consumes it; later deploys reuse the account.
 *
 * Minted once and cached: each prop below evaluates the effect, and the
 * pair must match. Props resolve `Output`s and `Config`s, not bare Effects,
 * so each half is lifted with `Output.fromEffect`.
 */
const zeroSslEab = Effect.runSync(
  Effect.cached(
    ZeroSsl.zerossl
      .generateEabCredentials({})
      .pipe(
        Effect.provide(
          Layer.mergeAll(ZeroSsl.CredentialsFromEnv, FetchHttpClient.layer),
        ),
        Effect.orDie,
      ),
  ),
);

/**
 * Let's Encrypt staging returned TLS errors from Workers during bring-up;
 * the deployed-Worker test uses ZeroSSL.
 */
export const ZeroSSLAccount = ACME.Account("ZeroSSL", {
  ca: ACME.ZeroSSL,
  eab: {
    keyId: Output.fromEffect(
      zeroSslEab.pipe(Effect.map((eab) => eab.eab_kid!)),
    ),
    hmacKey: Output.fromEffect(
      zeroSslEab.pipe(Effect.map((eab) => eab.eab_hmac_key!)),
    ),
  },
  termsOfServiceAgreed: true,
});
