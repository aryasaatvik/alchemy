import type {
  CredentialsError,
  ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  AWS_AUTH_PROVIDER_NAME,
  LOCAL_ACCOUNT_ID,
  type AwsAuthConfig,
  type AwsResolvedCredentials,
} from "./AuthProvider.ts";

export const AWS_PROFILE = Config.String("AWS_PROFILE").pipe(
  Config.withDefault("default"),
);

export const AWS_REGION = Config.String("AWS_REGION");
export const AWS_ACCOUNT_ID = Config.String("AWS_ACCOUNT_ID");
export const AWS_ACCESS_KEY_ID = Config.String("AWS_ACCESS_KEY_ID");
export const AWS_SECRET_ACCESS_KEY = Config.Redacted("AWS_SECRET_ACCESS_KEY");
export const AWS_SESSION_TOKEN = Config.Redacted("AWS_SESSION_TOKEN");

/**
 * The global endpoint override (`AWS_ENDPOINT_URL`) visible to application
 * code at runtime, or `undefined` when unset.
 */
export const AWS_ENDPOINT_URL = Config.String("AWS_ENDPOINT_URL").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

/**
 * Runtime environment variable carrying per-service endpoints as a JSON
 * object keyed by SDK service ID (see `Endpoint.ServiceEndpoints`). The
 * local Lambda provider sets it from `providers({ local: { lambda } })`.
 */
export const AWS_SERVICE_ENDPOINTS_ENV_VAR = "ALCHEMY_AWS_SERVICE_ENDPOINTS";

const ServiceEndpointsJson = Schema.fromJsonString(
  Schema.Record(
    Schema.String.check(Schema.isMinLength(1)),
    Schema.String.check(Schema.isMinLength(1)),
  ),
);

/**
 * Per-service endpoints visible to application code at runtime (decoded
 * from {@link AWS_SERVICE_ENDPOINTS_ENV_VAR}), or `undefined` when unset.
 * Fails with a `ConfigError` when the variable is not a JSON object of
 * non-empty endpoint strings.
 */
export const AWS_SERVICE_ENDPOINTS = Config.schema(
  ServiceEndpointsJson,
  AWS_SERVICE_ENDPOINTS_ENV_VAR,
).pipe(Config.option, Config.map(Option.getOrUndefined));

export type AccountID = string;
export type RegionID = string;

export class FailedToGetAccount extends Data.TaggedError(
  "AWS::Environment::FailedToGetAccount",
)<{
  message: string;
  cause: Error;
}> {}

/**
 * Fully-resolved AWS environment for a stack. Mirrors `CloudflareEnvironment`:
 * one Context.Service that holds account, region, credentials, endpoint, and
 * (optionally) the SSO profile name.
 *
 * `credentials` is held as an Effect so callers can refresh on each access
 * (SSO sessions expire). The Effect itself is constructed once when this
 * service is built; resolving it lazily preserves @distilled.cloud/aws's
 * existing `Credentials` semantics.
 */
export interface AWSEnvironmentShape {
  accountId: AccountID;
  region: RegionID;
  credentials: Effect.Effect<ResolvedCredentials, CredentialsError>;
  endpoint?: string;
  profile?: string;
  /**
   * Set by the local emulator context (see `AWS/Local/FlociServices.ts`),
   * whatever account the emulator was given.
   */
  emulator?: boolean;
}

export class AWSEnvironment extends Context.Service<
  AWSEnvironment,
  Effect.Effect<AWSEnvironmentShape>
>()("AWS::Environment") {
  static current = AWSEnvironment.use((env) => env);
  /**
   * Whether this environment is the floci emulator: marked by the local
   * emulator context, or on the dummy account {@link LOCAL_ACCOUNT_ID}. A
   * set `endpoint` is not enough: explicit endpoint overrides also populate
   * it on real-account credentials.
   */
  static isLocalEmulator = Effect.map(
    AWSEnvironment.current,
    (env) => env.emulator === true || env.accountId === LOCAL_ACCOUNT_ID,
  );
  readonly kind = "Environment" as const;
}

/** @see {@link AWSEnvironment.isLocalEmulator} */
export const isLocalEmulator = AWSEnvironment.isLocalEmulator;

export const Default = Layer.effect(
  AWSEnvironment,
  Effect.gen(function* () {
    // Provider layers are built on every run — before any profile may be
    // configured — so nothing may resolve at construction. A dev run with
    // zero AWS credentials builds this layer too (the ambient environment
    // is the emulator; only `Alchemy.remote()` rows ever need it), so the
    // profile/CI precedence is captured here and evaluated on first use,
    // exactly once.
    const resolve = resolveProviderConfig<
      AwsAuthConfig,
      AwsResolvedCredentials
    >(AWS_AUTH_PROVIDER_NAME).pipe(Effect.flatMap(({ resolve }) => resolve));
    const context = yield* Effect.context<Effect.Services<typeof resolve>>();
    return yield* resolve.pipe(
      Effect.provideContext(context),
      Effect.orDie,
      Effect.cached,
    );
  }),
).pipe(Layer.orDie);
