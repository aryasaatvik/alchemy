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
 * Derive a service-aware endpoint policy from the surrounding
 * {@link AWSEnvironment}. An operation-scoped {@link of} layer remains more
 * specific; otherwise distilled resolves through the configured service map,
 * then through the global local endpoint, then through its normal AWS rules.
 */
const makeFromEnvironment = <E, R>(
  overrides: Effect.Effect<Readonly<Record<string, string>>, E, R>,
) => {
  const configured = Layer.effect(ConfiguredServiceEndpoints, overrides);
  return Layer.effect(
    Endpoint.ServiceEndpoint,
    Effect.gen(function* () {
      // Forcing the environment resolves credentials — an unconfigured or
      // non-interactive profile must not fail layer construction. Defer that
      // failure to the first credential use and resolve endpoints from the
      // configured map alone in the meantime.
      const env = yield* AWSEnvironment.current.pipe(
        Effect.catchDefect(() => Effect.succeed(undefined)),
      );
      const serviceEndpoints = yield* ConfiguredServiceEndpoints;
      return {
        resolve: (service: string) =>
          serviceEndpoints[service] ??
          env?.serviceEndpoints?.[service] ??
          env?.endpoint,
      } satisfies Endpoint.ServiceEndpointResolver;
    }),
  ).pipe(Layer.provideMerge(configured));
};

export const fromEnvironment = makeFromEnvironment(Effect.succeed({}));

/** Derive a resolver with stack-owned service endpoint overrides. */
export const fromEnvironmentWithServiceEndpoints = <E, R>(
  endpoints: Effect.Effect<Readonly<Record<string, string>>, E, R>,
) => makeFromEnvironment(endpoints);
