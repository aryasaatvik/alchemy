import { Endpoint } from "@distilled.cloud/aws";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AWSEnvironment } from "./Environment.ts";

export const of = (endpoint: string) =>
  Layer.succeed(Endpoint.Endpoint, Effect.succeed(endpoint));

/**
 * Stack-owned overrides for individual AWS signing services.
 *
 * The surrounding {@link AWSEnvironment} still supplies the generic endpoint
 * (and may itself carry persisted service endpoints). This service is for a
 * stack whose local topology has one exceptional service, such as SES, while
 * all ordinary AWS calls remain directed at a LocalStack-compatible emulator.
 */
export class ServiceEndpointOverrides extends Context.Service<
  ServiceEndpointOverrides,
  Readonly<Record<string, string>>
>()("Alchemy::AWS::ServiceEndpointOverrides") {}

/** Provide a stack-owned mapping from AWS SigV4 service names to endpoints. */
export const serviceEndpoints = <E, R>(
  endpoints: Effect.Effect<Readonly<Record<string, string>>, E, R>,
): Layer.Layer<ServiceEndpointOverrides, E, R> =>
  Layer.effect(ServiceEndpointOverrides, endpoints);

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
    const overrides = yield* Effect.serviceOption(
      ServiceEndpointOverrides,
    ).pipe(Effect.map(Option.getOrElse(() => ({}))));
    return {
      resolve: (service: string) =>
        overrides[service] ?? env.serviceEndpoints?.[service] ?? env.endpoint,
    } satisfies Endpoint.ServiceEndpointResolver;
  }),
);
