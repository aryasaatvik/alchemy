import {
  Credentials,
  type CredentialsError,
  type ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  AWS_AUTH_PROVIDER_NAME,
  type AwsAuthConfig,
  type AwsResolvedCredentials,
  localAwsCredentials,
} from "./AuthProvider.ts";
import { ensureLocalEmulator } from "./LocalEmulator.ts";

export const AWS_PROFILE = Config.string("AWS_PROFILE").pipe(
  Config.withDefault("default"),
);

export const AWS_REGION = Config.string("AWS_REGION");
export const AWS_ACCOUNT_ID = Config.string("AWS_ACCOUNT_ID");
export const AWS_ACCESS_KEY_ID = Config.string("AWS_ACCESS_KEY_ID");
export const AWS_SECRET_ACCESS_KEY = Config.redacted("AWS_SECRET_ACCESS_KEY");
export const AWS_SESSION_TOKEN = Config.redacted("AWS_SESSION_TOKEN");
export const AWS_SERVICE_ENDPOINTS_ENV_VAR = "ALCHEMY_AWS_SERVICE_ENDPOINTS";

/** Global AWS endpoint visible inside an application runtime. */
export const AWS_ENDPOINT_URL = Config.string("AWS_ENDPOINT_URL").pipe(
  Config.option,
  Effect.map(Option.getOrUndefined),
);

export class InvalidAWSServiceEndpoints extends Data.TaggedError(
  "AWS::Environment::InvalidServiceEndpoints",
)<{ readonly message: string }> {}

const decodeServiceEndpoints = (raw: string) =>
  Effect.try({
    try: () => {
      const value: unknown = JSON.parse(raw);
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

/** Service-specific endpoint policy captured by the declaring AWS provider. */
export const AWS_SERVICE_ENDPOINTS = Config.string(
  AWS_SERVICE_ENDPOINTS_ENV_VAR,
).pipe(
  Config.option,
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(undefined),
      onSome: decodeServiceEndpoints,
    }),
  ),
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
  /** Endpoint overrides keyed by AWS SigV4 service name (for example `ses`). */
  serviceEndpoints?: Readonly<Record<string, string>>;
  profile?: string;
}

export class AWSEnvironment extends Context.Service<
  AWSEnvironment,
  Effect.Effect<AWSEnvironmentShape>
>()("AWS::Environment") {
  static current = AWSEnvironment.use((env) => env);
  readonly kind = "Environment" as const;
}

/**
 * Runtime-only AWS environment for generated Lambda entrypoints. It uses the
 * already-provided process credentials and Region and reads endpoint policy
 * only from the runtime Config provider; it never loads a profile, contacts
 * metadata, or starts an emulator.
 */
export const Runtime = Layer.effect(
  AWSEnvironment,
  Effect.all({
    accountId: Config.string("ALCHEMY_AWS_ACCOUNT_ID"),
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
    // An explicit endpoint is a target selection, not an ambient profile
    // override. This lets a supervisor derive a worktree-local Floci account
    // without writing to the developer's shared Alchemy profile, while an
    // ordinary deploy keeps its existing profile-driven identity.
    const endpoint = yield* AWS_ENDPOINT_URL;
    if (endpoint !== undefined) {
      const accountId = yield* AWS_ACCOUNT_ID;
      const region = yield* AWS_REGION;
      const local = yield* localAwsCredentials({
        method: "local",
        endpoint,
        accountId,
        region,
        autoStart: false,
      });
      yield* ensureLocalEmulator({
        endpoint,
        autoStart: false,
      });
      return Effect.succeed(local);
    }

    const profile = yield* AlchemyProfile;
    const auth = yield* getAuthProvider<AwsAuthConfig, AwsResolvedCredentials>(
      AWS_AUTH_PROVIDER_NAME,
    );
    const profileName = yield* ALCHEMY_PROFILE;
    const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

    return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
      Effect.flatMap((config) => auth.read(profileName, config)),
      Effect.orDie,
      Effect.cached,
    );
  }),
).pipe(Layer.orDie);
