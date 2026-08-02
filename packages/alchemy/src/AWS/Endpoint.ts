import { Endpoint } from "@distilled.cloud/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export const of = (endpoint: string) =>
  Layer.succeed(Endpoint.Endpoint, Effect.succeed(endpoint));

/**
 * Derive a service-aware endpoint policy from the surrounding
 * {@link AWSEnvironment}. An operation-scoped {@link of} layer remains more
 * specific; otherwise distilled resolves the SigV4 service name first in
 * `serviceEndpoints`, then through the global local endpoint, then through
 * its normal AWS endpoint rules.
 */
export const fromEnvironment: Layer.Layer<
  Endpoint.ServiceEndpoint,
  never,
  AWSEnvironment
> = Layer.effect(
  Endpoint.ServiceEndpoint,
  Effect.gen(function* () {
    const env = yield* AWSEnvironment;
    return {
      resolve: (service: string) =>
        env.serviceEndpoints?.[service] ?? env.endpoint,
    } satisfies Endpoint.ServiceEndpointResolver;
  }),
);
