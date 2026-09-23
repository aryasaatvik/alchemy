/** @effect-diagnostics anyUnknownInErrorContext:off */

import * as Floci from "@alchemy.run/floci";
import type { FlociError } from "@alchemy.run/floci";
import { Endpoint as AwsEndpoint } from "@distilled.cloud/aws";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as ProviderSessionConfig from "../../Local/ProviderSessionConfig.ts";
import type { Platform } from "../../Platform.ts";
import type { ResourceClassLike, ResourceLike } from "../../Resource.ts";
import { DEFAULT_LOCAL_ENDPOINT, LOCAL_ACCOUNT_ID } from "../AuthProvider.ts";
import * as Endpoint from "../Endpoint.ts";
import type { ServiceEndpoints } from "../Endpoint.ts";
import { AWSEnvironment } from "../Environment.ts";
import * as Region from "../Region.ts";
import { provideProviderContext } from "./ProviderContext.ts";

/**
 * Fixed dummy account used for every floci-emulated resource unless the
 * stack selects another one ({@link LocalProfile.accountId}). Attributes
 * computed from it (ARNs, queue URLs) double as proof that no real AWS
 * account was involved.
 */
export const FLOCI_ACCOUNT_ID = LOCAL_ACCOUNT_ID;

/** Default region of floci-emulated resources. */
export const FLOCI_REGION = "us-east-1";

/**
 * Where a stack's local AWS resources live: one account on one emulator.
 * Floci partitions its state by account (keyed on the signing access key),
 * so separate accounts on a shared emulator stay isolated.
 */
export interface LocalProfile {
  /**
   * Emulator account. Requests are signed with this id as the access key,
   * which is how floci selects the account.
   * @default "000000000000"
   */
  readonly accountId?: string;
  /**
   * Region for signing and generated attributes.
   * @default "us-east-1"
   */
  readonly region?: string;
  /**
   * Emulator gateway URL. A custom endpoint is owned by the caller and is
   * never auto-started; the default one starts (or reuses) the managed
   * `alchemy-floci` container.
   * @default "http://localhost:4566"
   */
  readonly endpoint?: string;
}

/**
 * The `"AWS"` entry of the {@link ProviderSessionConfig}: everything a
 * local AWS provider needs from the stack's `AWS.providers(...)` options,
 * in either process (the stack process or the dev sidecar).
 */
export interface AwsSessionConfig {
  readonly local?: LocalProfile;
  readonly serviceEndpoints?: ServiceEndpoints;
}

export const AWS_SESSION_NAMESPACE = "AWS";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

const AwsSessionConfigSchema = Schema.Struct({
  local: Schema.optional(
    Schema.Struct({
      accountId: Schema.optional(NonEmptyString),
      region: Schema.optional(NonEmptyString),
      endpoint: Schema.optional(NonEmptyString),
    }),
  ),
  serviceEndpoints: Schema.optional(
    Schema.Record(NonEmptyString, NonEmptyString),
  ),
});

/** Place the AWS entry in the {@link ProviderSessionConfig}. */
export const awsSessionConfig = (config: AwsSessionConfig) =>
  ProviderSessionConfig.layer(AWS_SESSION_NAMESPACE, config);

/**
 * The AWS entry of the ambient {@link ProviderSessionConfig} (`{}` when no
 * stack set one). Dies on a malformed entry: it is produced by
 * `AWS.providers(...)`, so a bad shape is a bug, not user input.
 */
export const currentAwsSessionConfig: Effect.Effect<AwsSessionConfig> =
  ProviderSessionConfig.get(AWS_SESSION_NAMESPACE).pipe(
    Effect.flatMap((entry) =>
      entry === undefined
        ? Effect.succeed({})
        : Schema.decodeUnknownEffect(AwsSessionConfigSchema)(entry),
    ),
    Effect.orDie,
  );

const portOf = (endpoint: string) => {
  const port = Number.parseInt(new URL(endpoint).port, 10);
  return Number.isNaN(port) ? Floci.DEFAULT_FLOCI_PORT : port;
};

// Annotated (not inferred): the inferred union names distilled's Endpoint
// through a non-portable relative path (TS2883), and consumers only ever
// hand this to `provideProviderContext`, which takes `Layer<any, any, never>`.
const makeFlociServices = (
  config: AwsSessionConfig,
): Layer.Layer<any, FlociError, never> => {
  const accountId = config.local?.accountId ?? FLOCI_ACCOUNT_ID;
  const region = config.local?.region ?? FLOCI_REGION;
  const endpoint = config.local?.endpoint ?? DEFAULT_LOCAL_ENDPOINT;
  const resolved = {
    accessKeyId: Redacted.make(
      accountId === FLOCI_ACCOUNT_ID ? "test" : accountId,
    ),
    secretAccessKey: Redacted.make("test"),
    sessionToken: undefined,
    region: region as RegionName,
  };
  const credentials = Effect.succeed(resolved);
  return Layer.mergeAll(
    // Pin every distilled SDK call made by a wrapped lifecycle method to the
    // emulator gateway with the profile's credentials in its region. Every
    // service goes to the gateway except those `serviceEndpoints` routes
    // elsewhere; `Endpoint` is cleared so that routing is consulted.
    Layer.succeed(AwsEndpoint.Endpoint, Effect.succeed(undefined)),
    Layer.succeed(
      AwsEndpoint.ServiceEndpoint,
      Endpoint.serviceEndpointResolver(config.serviceEndpoints, endpoint),
    ),
    Region.of(region),
    Layer.succeed(Credentials, credentials),
    // Providers read `AWSEnvironment.current` inside lifecycle operations to
    // compute ARNs/attrs (accountId, region) — override it so computed
    // identities carry the emulator account and the emulator endpoint.
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId,
        region,
        credentials,
        endpoint,
        emulator: true,
      }),
    ),
    // Building the services guarantees the managed emulator is serving:
    // reuses anything already listening on the endpoint, otherwise starts
    // (or revives) the `alchemy-floci` container and waits for health. A
    // custom endpoint belongs to whoever configured it.
    Layer.effectDiscard(
      endpoint === DEFAULT_LOCAL_ENDPOINT
        ? Floci.ensureFloci({ port: portOf(endpoint) })
        : Effect.void,
    ),
  );
};

// One layer reference per distinct configuration, so the stack build's
// MemoMap constructs it — and runs `ensureFloci()` — once per stack build
// and configuration (see the note on
// [Local/ProviderLayer.ts](../../Local/ProviderLayer.ts)).
const flociServicesByConfig = new Map<
  string,
  Layer.Layer<any, FlociError, never>
>();

const flociServicesFor = (config: AwsSessionConfig) => {
  const key = JSON.stringify([
    config.local?.accountId,
    config.local?.region,
    config.local?.endpoint,
    Object.entries(config.serviceEndpoints ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  ]);
  let layer = flociServicesByConfig.get(key);
  if (layer === undefined) {
    layer = makeFlociServices(config);
    flociServicesByConfig.set(key, layer);
  }
  return layer;
};

// A single reference for every caller: binding routing compares data planes
// by identity (`routeClientDataPlane` in Binding.ts), so two local resources
// must hand it the same layer. The per-configuration layers above stay
// memoized per session configuration.
let flociServicesLayer: Layer.Layer<any, FlociError, never> | undefined;

/**
 * The floci-scoped override context for local-mode AWS providers: the
 * emulator endpoint, credentials, region and {@link AWSEnvironment} of the
 * stack's {@link LocalProfile} and service endpoints, read from the ambient
 * {@link ProviderSessionConfig} (the defaults when none is set). Built only
 * when a local-mode provider is actually demanded.
 */
export const flociServices = (): Layer.Layer<any, FlociError, never> =>
  (flociServicesLayer ??= Layer.unwrap(
    Effect.map(currentAwsSessionConfig, flociServicesFor),
  ));

/**
 * Registers an AWS resource provider with both a **live** and a **local**
 * (floci-emulated) implementation via `ProviderLayer.dual`. The local
 * variant is the SAME live provider code with every lifecycle method
 * endpoint-wrapped to the floci emulator ({@link flociServices}), so
 * `alchemy dev` routes the resource to the emulator while `alchemy deploy`
 * (and `Alchemy.remote()` in dev) keeps hitting the real cloud.
 *
 * @example
 * ```ts
 * // in Providers.ts, replacing `S3.BucketProvider(),`:
 * flociDual(S3.Bucket, () => S3.BucketProvider()),
 * ```
 */
export const flociDual = <
  R extends ResourceLike,
  L extends Layer.Layer<any, any, any>,
>(
  cls:
    | ResourceClassLike<R>
    | Platform<R, any, any, any, any>
    | { Type: R["Type"] },
  live: () => L,
) =>
  ProviderLayer.dual(cls, {
    live,
    local: () => provideProviderContext(live(), flociServices()),
    // Registered as the resource's local data plane so deploy-time binding
    // clients (Action bodies, plan-time `execute`) route their API calls to
    // the emulator whenever the bound resource resolves to local mode.
    dataPlane: flociServices,
  });
