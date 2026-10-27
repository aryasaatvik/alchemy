import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { AccessKey } from "@alchemy.run/aws/IAM/AccessKey";
import { Role } from "@alchemy.run/aws/IAM/Role";
import { User } from "@alchemy.run/aws/IAM/User";
import { GetSecretValue } from "@alchemy.run/aws/SecretsManager/GetSecretValue";
import { GetSecretValueHttp } from "@alchemy.run/aws/SecretsManager/GetSecretValueHttp";
import { external } from "@alchemy.run/aws/SecretsManager/Secret";
import { expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { mock as mockCredentials } from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as Provider from "alchemy/Provider";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";

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
      requests.push(JSON.parse(new TextDecoder().decode(body.body ?? new Uint8Array())));
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
    expect(bindings[0]!.id).toBe("Allow(Host, AWS.SecretsManager.GetSecretValue(ApiSecrets))");
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
    Effect.provide(
      Layer.mergeAll(
        Provider.succeed(User, {
          reconcile: () => Effect.die("unexpected user write"),
          delete: () => Effect.void,
        }),
        Provider.succeed(AccessKey, {
          reconcile: () => Effect.die("unexpected key write"),
          delete: () => Effect.void,
        }),
        Provider.succeed(Role, {
          reconcile: () => Effect.die("unexpected role write"),
          delete: () => Effect.void,
        }),
      ),
    ),
    Effect.provide(mockCredentials),
    Effect.provide(Region.of("us-east-1")),
    Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Effect.provide(Layer.succeed(Self, host)),
    Effect.provide(Layer.succeed(RuntimeContext, runtime)),
  );
});

const externalHostTests = Test.make({
  providers: Layer.mergeAll(
    Provider.succeed(User, {
      reconcile: () => Effect.die("plan must not create an IAM user"),
      delete: () => Effect.void,
    }),
    Provider.succeed(AccessKey, {
      reconcile: () => Effect.die("plan must not create an IAM key"),
      delete: () => Effect.void,
    }),
    Provider.succeed(Role, {
      reconcile: () => Effect.die("plan must not create an IAM role"),
      delete: () => Effect.void,
    }),
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: "123",
        region: "us-east-1",
        credentials: Effect.die("plan must not resolve credentials"),
      }),
    ),
  ),
  state: inMemoryState(),
});

externalHostTests.test.provider(
  "an external host grants Secret.Reference permissions on its minted IAM role",
  (stack) =>
    Effect.gen(function* () {
      const runtime = {
        Type: "Cloudflare.Worker",
        id: "SecretConsumer",
        env: {},
        set: (id: string) => Effect.succeed(id),
        get: <T>() => Effect.succeed<T | undefined>(undefined),
      };
      const secret = external("SharedSecret", {
        secretId: "operator-owned",
        secretArn: "arn:aws:secretsmanager:us-east-1:123:secret:operator-owned-*",
      });
      const host = {
        Type: "Cloudflare.Worker",
        LogicalId: "SecretConsumer",
        FQN: "SecretConsumer",
      };
      const program = GetSecretValue(secret).pipe(
        Effect.provide(GetSecretValueHttp),
        Effect.provideService(Self, host),
        Effect.provideService(RuntimeContext, runtime),
      );
      const plan = yield* stack.plan(program);
      const statements = plan.resources.SecretConsumerRole?.bindings.flatMap(
        (binding) => binding.data.policyStatements ?? [],
      );
      expect(statements).toEqual(
        expect.arrayContaining([
          {
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue"],
            Resource: ["arn:aws:secretsmanager:us-east-1:123:secret:operator-owned-*"],
          },
        ]),
      );
      expect(Object.values(plan.resources).map((node) => node.resource.Type)).not.toContain(
        "AWS.SecretsManager.Secret",
      );
    }),
  { tags: ["unit", "provider:aws", "local"], timeout: 10_000 },
);
