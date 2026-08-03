import { Endpoint } from "@distilled.cloud/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export const of = (endpoint: string) =>
  Layer.succeed(Endpoint.Endpoint, Effect.succeed(endpoint));

/**
 * Derive a service-aware endpoint policy from the surrounding
 * {@link AWSEnvironment}. An operation-scoped {@link of} layer remains more
 * specific; otherwise distilled resolves through the configured service map,
 * then through the global local endpoint, then through its normal AWS rules.
 */
const makeFromEnvironment = <E, R>(
  overrides: Effect.Effect<Readonly<Record<string, string>>, E, R>,
) =>
  Layer.effect(
    Endpoint.ServiceEndpoint,
    Effect.gen(function* () {
      const env = yield* AWSEnvironment.current;
      const serviceEndpoints = yield* overrides;
      return {
        resolve: (service: string) =>
          serviceEndpoints[service] ??
          env.serviceEndpoints?.[service] ??
          env.endpoint,
      } satisfies Endpoint.ServiceEndpointResolver;
    }),
  );

export const fromEnvironment = makeFromEnvironment(Effect.succeed({}));

/** Derive a resolver with stack-owned service endpoint overrides. */
export const fromEnvironmentWithServiceEndpoints = <E, R>(
  endpoints: Effect.Effect<Readonly<Record<string, string>>, E, R>,
) => makeFromEnvironment(endpoints);
