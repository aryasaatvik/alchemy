import { GetSecretValue } from "@/AWS/SecretsManager/GetSecretValue.ts";
import { GetSecretValueHttp } from "@/AWS/SecretsManager/GetSecretValueHttp.ts";
import { external } from "@/AWS/SecretsManager/Secret.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { Self } from "@/Self.ts";
import { mock as mockCredentials } from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

it.effect("binds an operator-owned secret without managing it", () => {
  const bindings: Array<{ id: string; data: any }> = [];
  const host = {
    Type: "AWS.Lambda.Function",
    LogicalId: "Host",
    FQN: "Host",
    bind:
      (template: TemplateStringsArray, ...args: unknown[]) =>
      (data: unknown) =>
        Effect.sync(() => {
          bindings.push({
            id: template.reduce(
              (id, part, i) =>
                id +
                part +
                (i < args.length
                  ? typeof args[i] === "string"
                    ? args[i]
                    : (args[i] as { LogicalId: string }).LogicalId
                  : ""),
              "",
            ),
            data,
          });
        }),
  };
  const runtime = {
    Type: "AWS.Lambda.Function",
    id: "Host",
    env: {},
    // An external reference must never round-trip through the env.
    set: (id: string) => Effect.die(new Error(`unexpected env binding ${id}`)),
    get: () => Effect.die(new Error("unexpected env read")),
  };
  const requests: unknown[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body as { _tag: string; body?: Uint8Array };
      requests.push(
        JSON.parse(new TextDecoder().decode(body.body ?? new Uint8Array())),
      );
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ Name: "samva-api-test" }), {
          status: 200,
          headers: { "content-type": "application/x-amz-json-1.1" },
        }),
      );
    }),
  );
  const secret = external("ApiSecrets", {
    secretId: "samva-api-test",
    secretArn: "arn:aws:secretsmanager:us-east-1:123:secret:samva-api-test-*",
  });

  return Effect.gen(function* () {
    const bind = yield* GetSecretValue;
    const getSecretValue = yield* bind(secret);

    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.id).toBe(
      "Allow(Host, AWS.SecretsManager.GetSecretValue(ApiSecrets))",
    );
    const [statement] = bindings[0]!.data.policyStatements;
    expect(statement.Action).toEqual(["secretsmanager:GetSecretValue"]);
    expect(statement.Resource).toEqual([
      "arn:aws:secretsmanager:us-east-1:123:secret:samva-api-test-*",
    ]);

    // At runtime the request addresses the declared id, not the IAM pattern.
    yield* getSecretValue();
    expect(requests).toEqual([{ SecretId: "samva-api-test" }]);
  }).pipe(
    Effect.provide(GetSecretValueHttp),
    Effect.provide(mockCredentials),
    Effect.provide(Region.of("us-east-1")),
    Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Effect.provide(Layer.succeed(Self, host as any)),
    Effect.provide(Layer.succeed(RuntimeContext, runtime as any)),
  );
});
