import { AWSEnvironment } from "@/AWS/Environment.ts";
import { placeLocalLambdaEnvironment } from "@/AWS/Lambda/FlociFunctionProvider.ts";
import {
  currentAwsSessionConfig,
  flociServices,
} from "@/AWS/Local/FlociServices.ts";
import * as RpcProvider from "@/Local/RpcProvider.ts";
import { Resource } from "@/Resource.ts";
import { packEnvValue } from "@/RuntimeContext.ts";
import { Endpoint } from "@distilled.cloud/aws";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** A function environment as the Lambda provider computes it on the host. */
export const HOST_LAMBDA_ENVIRONMENT = {
  DATABASE_URL: packEnvValue(Redacted.make("postgres://127.0.0.1:54329/db")),
  PLAIN: "unchanged",
};

/**
 * Reports the local AWS context its provider observes: the emulator
 * identity and endpoint routing of `flociServices()`, plus the pid of the
 * process the lifecycle ran in.
 */
export interface LocalProfileProbe extends Resource<
  "Test.AWS.LocalProfileProbe",
  {},
  {
    accountId: string;
    region: string;
    endpoint: string | undefined;
    emulator: boolean;
    s3Endpoint: string | undefined;
    sesEndpoint: string | undefined;
    lambdaEnvironment: Record<string, string>;
    pid: number;
  }
> {}

export const LocalProfileProbe = Resource<LocalProfileProbe>(
  "Test.AWS.LocalProfileProbe",
);

const observe = Effect.gen(function* () {
  const env = yield* AWSEnvironment.current;
  return {
    accountId: env.accountId,
    region: env.region,
    endpoint: env.endpoint,
    emulator: yield* AWSEnvironment.isLocalEmulator,
    s3Endpoint: yield* Endpoint.resolve("S3"),
    sesEndpoint: yield* Endpoint.resolve("SESv2"),
    lambdaEnvironment: placeLocalLambdaEnvironment(
      HOST_LAMBDA_ENVIRONMENT,
      (yield* currentAwsSessionConfig).local?.lambda,
    ),
    pid: process.pid,
  };
}).pipe(Effect.provide(flociServices()));

/** Served from the dev sidecar through `./group.ts`. */
export const LocalProfileProbeProvider = () =>
  RpcProvider.effect(
    LocalProfileProbe,
    import.meta.resolve("./group.ts"),
    Effect.succeed({
      reconcile: () => observe,
      delete: () => Effect.void,
    }),
  );
