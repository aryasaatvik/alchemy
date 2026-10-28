import { WorkflowCallbackStore } from "@alchemy.run/aws/Lambda/WorkflowFunction";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const services = (endpoint: string) =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(Endpoint, Effect.succeed(endpoint)),
    Layer.succeed(Region, Effect.succeed("us-east-1")),
    Layer.succeed(
      Credentials,
      Effect.succeed({
        accessKeyId: Redacted.make("test"),
        secretAccessKey: Redacted.make("test"),
        sessionToken: undefined,
        region: "us-east-1" as const,
      }),
    ),
    Layer.succeed(WorkflowCallbackStore, {
      register: (token, id) =>
        Effect.promise(async () => {
          const response = await fetch(`${endpoint}/pr3-workflow-callbacks/${token}`, {
            method: "PUT",
            body: id,
          });
          if (!response.ok) throw new Error(`register: ${response.status}`);
        }),
      lookup: (token) =>
        Effect.promise(async () => {
          const response = await fetch(`${endpoint}/pr3-workflow-callbacks/${token}`);
          if (!response.ok) throw new Error(`lookup: ${response.status}`);
          return response.text();
        }),
    }),
  );
