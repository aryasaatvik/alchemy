import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const endpoint = process.env.WORKFLOW_FLOCI_ENDPOINT;
const environment = Layer.succeed(
  AWSEnvironment,
  Effect.succeed({
    accountId: "000000000000",
    region: "us-east-1",
    endpoint,
    emulator: true,
    credentials: Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as const,
    }),
  }),
);
export const testOptions = endpoint
  ? {
      dev: false,
      providers: AWS.providers({
        local: { endpoint, lambda: { endpoint: "http://floci:4566" } },
      }).pipe(Layer.provide(environment)),
    }
  : { providers: AWS.providers() };
