import { Endpoint } from "@distilled.cloud/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export const of = (endpoint: string) =>
  Layer.succeed(Endpoint.Endpoint, Effect.succeed(endpoint));

/**
 * Endpoints for individual AWS services, keyed by SDK service ID (`"S3"`,
 * `"SESv2"`, `"Service Quotas"`). Keys match case- and
 * punctuation-insensitively, so `"sesv2"` and `"service_quotas"` select the
 * same services as their SDK IDs.
 */
export type ServiceEndpoints = Readonly<Record<string, string>>;

const normalizeServiceId = (service: string) =>
  service.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A distilled {@link Endpoint.ServiceEndpointResolver} over a
 * {@link ServiceEndpoints} map. Services without an entry resolve to
 * `fallback` (`undefined` keeps the SDK's default endpoint rules).
 */
export const serviceEndpointResolver = (
  serviceEndpoints: ServiceEndpoints | undefined,
  fallback?: string,
): Endpoint.ServiceEndpointResolver => {
  const byService = new Map(
    Object.entries(serviceEndpoints ?? {}).map(([service, endpoint]) => [
      normalizeServiceId(service),
      endpoint,
    ]),
  );
  return {
    resolve: (service) =>
      byService.get(normalizeServiceId(service)) ?? fallback,
  };
};

/**
 * Route individual AWS services to their own endpoints. Distilled consults
 * this only when no explicit {@link Endpoint.Endpoint} is set for the call,
 * so an operation-scoped `Endpoint.of(...)` still wins.
 */
export const services = (serviceEndpoints: ServiceEndpoints) =>
  Layer.succeed(
    Endpoint.ServiceEndpoint,
    serviceEndpointResolver(serviceEndpoints),
  );

/**
 * Derive a custom endpoint (if any) from the surrounding
 * {@link AWSEnvironment}. If the environment has no `endpoint` set, this
 * Layer is empty (the SDK uses its default endpoint resolver).
 */
export const fromEnvironment: Layer.Layer<never, never, AWSEnvironment> =
  Layer.effect(
    Endpoint.Endpoint,
    Effect.gen(function* () {
      return Effect.map(
        yield* AWSEnvironment,
        (env) => env.endpoint ?? undefined!,
      );
    }),
  );

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
