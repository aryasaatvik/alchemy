import { Endpoint } from "@distilled.cloud/aws";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export const of = (endpoint: string) =>
  Layer.succeed(Endpoint.Endpoint, Effect.succeed(endpoint));

/** Service endpoint map selected by the declaring AWS provider. */
export class ConfiguredServiceEndpoints extends Context.Service<
  ConfiguredServiceEndpoints,
  Readonly<Record<string, string>>
>()("AWS::ConfiguredServiceEndpoints") {}

/**
 * Derive a custom endpoint (if any) from the surrounding
 * {@link AWSEnvironment}. If the environment has no `endpoint` set, this
 * Layer is empty (the SDK uses its default endpoint resolver).
 */
const makeFromEnvironment = <E, R>(
  overrides: Effect.Effect<Readonly<Record<string, string>>, E, R>,
) => {
  const configured = Layer.effect(ConfiguredServiceEndpoints, overrides);
  return Layer.effect(
    Endpoint.ServiceEndpoint,
    Effect.gen(function* () {
      const env = yield* AWSEnvironment.current.pipe(
        Effect.catchDefect(() => Effect.succeed(undefined)),
      );
      const serviceEndpoints = yield* ConfiguredServiceEndpoints;
      const resolveConfigured = (
        configured: Readonly<Record<string, string>> | undefined,
        service: string,
      ) =>
        configured?.[service] ??
        configured?.[service.toLowerCase().replace(/[^a-z0-9]/g, "")];
      return {
        resolve: (service: string) =>
          resolveConfigured(serviceEndpoints, service) ??
          resolveConfigured(env?.serviceEndpoints, service) ??
          env?.endpoint,
      } satisfies Endpoint.ServiceEndpointResolver;
    }),
  ).pipe(Layer.provideMerge(configured));
};

export const fromEnvironment = makeFromEnvironment(Effect.succeed({}));

export const fromEnvironmentWithServiceEndpoints = <E, R>(
  endpoints: Effect.Effect<Readonly<Record<string, string>>, E, R>,
) => makeFromEnvironment(endpoints);

/**
 * Explicitly "no custom endpoint" — the SDK falls back to its default
 * endpoint resolver.
 *
 * Use this (never `Layer.empty`) when an AWS call is made from *inside*
 * the construction of {@link AWSEnvironment}: leaving `Endpoint`
 * unprovided lets the call fall through to {@link fromEnvironment},
 * whose service Effect re-enters the in-flight `AWSEnvironment` cache and
 * deadlocks the fiber with no I/O and no timer pending.
 */
export const none = Layer.succeed(Endpoint.Endpoint, Effect.succeed(undefined));
