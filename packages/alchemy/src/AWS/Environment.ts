import type {
  CredentialsError,
  ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
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
export const AWS_SERVICE_ENDPOINTS_ENV_VAR = "ALCHEMY_AWS_SERVICE_ENDPOINTS";

/** Global AWS endpoint visible inside an application runtime. */
export const AWS_ENDPOINT_URL = Config.String("AWS_ENDPOINT_URL").pipe(
  Config.option,
  Effect.map(Option.getOrUndefined),
);

export class InvalidAWSServiceEndpoints extends Data.TaggedError(
  "AWS::Environment::InvalidServiceEndpoints",
)<{ readonly message: string }> {}

const decodeServiceEndpoints = (raw: unknown) =>
  Effect.try({
    try: () => {
      const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([service, endpoint]) =>
            service.length === 0 ||
            typeof endpoint !== "string" ||
            endpoint.length === 0,
        )
      ) {
        throw new TypeError("expected a non-empty string endpoint record");
      }
      return value as Readonly<Record<string, string>>;
    },
    catch: () =>
      new InvalidAWSServiceEndpoints({
        message: `${AWS_SERVICE_ENDPOINTS_ENV_VAR} must contain a JSON object of non-empty service endpoints`,
      }),
  });

/** Service-specific AWS endpoints visible inside an application runtime. */
export const AWS_SERVICE_ENDPOINTS = ConfigProvider.ConfigProvider.pipe(
  Effect.flatMap((provider) => provider.load([AWS_SERVICE_ENDPOINTS_ENV_VAR])),
  Effect.flatMap((node) => {
    if (node === undefined) return Effect.succeed(undefined);
    return node._tag === "Value"
      ? decodeServiceEndpoints(node.value)
      : Effect.fail(
          new InvalidAWSServiceEndpoints({
            message: `${AWS_SERVICE_ENDPOINTS_ENV_VAR} must contain a JSON object of non-empty service endpoints`,
          }),
        );
  }),
);

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
  serviceEndpoints?: Readonly<Record<string, string>>;
  profile?: string;
}

export class AWSEnvironment extends Context.Service<
  AWSEnvironment,
  Effect.Effect<AWSEnvironmentShape>
>()("AWS::Environment") {
  static current = AWSEnvironment.use((env) => env);
  /**
   * Whether this environment is the floci emulator
   * (dummy account {@link LOCAL_ACCOUNT_ID}). A set `endpoint` is not
   * enough: `AWS_ENDPOINT_URL` and explicit endpoint overrides also
   * populate it on real-account credentials.
   */
  static isLocalEmulator = Effect.map(
    AWSEnvironment.current,
    (env) => env.accountId === LOCAL_ACCOUNT_ID,
  );
  readonly kind = "Environment" as const;
}

/** @see {@link AWSEnvironment.isLocalEmulator} */
export const isLocalEmulator = AWSEnvironment.isLocalEmulator;

/** Runtime-only AWS environment for generated Lambda entrypoints. */
export const Runtime = Layer.effect(
  AWSEnvironment,
  Effect.all({
    accountId: Config.String("ALCHEMY_AWS_ACCOUNT_ID"),
    credentials: Credentials,
    endpoint: AWS_ENDPOINT_URL,
    region: Region,
    serviceEndpoints: AWS_SERVICE_ENDPOINTS,
  }).pipe(
    Effect.map(
      ({ accountId, credentials, endpoint, region, serviceEndpoints }) =>
        region.pipe(
          Effect.map((region) => ({
            accountId,
            credentials,
            endpoint,
            region,
            serviceEndpoints,
          })),
        ),
    ),
  ),
);

export const Default = Layer.effect(
  AWSEnvironment,
  Effect.gen(function* () {
    const endpoint = yield* AWS_ENDPOINT_URL;
    const serviceEndpoints = yield* AWS_SERVICE_ENDPOINTS;
    // An explicit emulator endpoint must win over ambient credentials and
    // profiles so a local run cannot target the real account by accident.
    if (endpoint !== undefined) {
      const accountId = yield* AWS_ACCOUNT_ID.pipe(
        Config.withDefault(LOCAL_ACCOUNT_ID),
      );
      const region = yield* AWS_REGION.pipe(Config.withDefault("us-east-1"));
      return yield* Effect.succeed({
        accountId,
        credentials: Effect.succeed({
          accessKeyId: Redacted.make("test"),
          secretAccessKey: Redacted.make("test"),
          sessionToken: undefined,
          region,
        }),
        endpoint,
        region,
        serviceEndpoints,
      }).pipe(Effect.cached);
    }
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
    return yield* Effect.map(resolve, (resolved) => ({
      ...resolved,
      serviceEndpoints,
    })).pipe(Effect.provideContext(context), Effect.orDie, Effect.cached);
  }),
).pipe(Layer.orDie);
