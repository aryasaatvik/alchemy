import { describe, expect, test } from "bun:test";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Endpoint, ServiceEndpoint } from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import { Retry } from "@distilled.cloud/aws/Retry";
import * as S3 from "@distilled.cloud/aws/s3";
import { SigningKeyCache } from "@distilled.cloud/aws/SigV4";
import { ResponseValidation } from "@distilled.cloud/core/response-validation";
import { ServerRetryHintCapMs } from "@distilled.cloud/core/retry";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as AWSBindings from "../../../src/AWS/AWSBindings.ts";
import { makeBucketHttpBinding } from "../../../src/AWS/S3/BindingHttp.ts";
import { Bucket } from "../../../src/AWS/S3/Bucket.ts";
import * as Provider from "../../../src/Provider.ts";
import { Resource } from "../../../src/Resource.ts";
import { RuntimeContext, sanitizeKey, unpackEnvValue } from "../../../src/RuntimeContext.ts";
import { Self } from "../../../src/Self.ts";
import { StackContext } from "../../../src/StackContext.ts";

class InitializationState extends Context.Service<InitializationState, string>()(
  "test/InitializationState",
) {}

const credentials = (id: string) =>
  Effect.succeed({
    accessKeyId: Redacted.make(id),
    secretAccessKey: Redacted.make("test-secret"),
    sessionToken: Redacted.make("test-session"),
    region: "us-east-1",
  });

const stack = (): Context.Service.Shape<typeof StackContext> => ({
  name: "test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
});
const NativeHost = Resource<Resource<"AWS.Lambda.Function", {}>>("AWS.Lambda.Function");
const ExternalHost = Resource<Resource<"Cloudflare.Worker", {}>>("Cloudflare.Worker");

const runtime = (env: Record<string, string>) =>
  RuntimeContext.of({
    Type: "test",
    id: "test",
    env,
    set: (key) => Effect.succeed(key),
    get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(env[key])),
  });

const assertNoInitialization = Effect.gen(function* () {
  expect(Option.isNone(yield* Effect.serviceOption(InitializationState))).toBe(true);
  expect(Option.isNone(yield* Effect.serviceOption(RuntimeContext))).toBe(true);
  expect(Option.isNone(yield* Effect.serviceOption(Scope.Scope))).toBe(true);
});

const initialize = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(InitializationState, "initialization-only"), Effect.scoped);

describe("AWS binding operation lifetime", () => {
  for (const [name, endpoint, serviceEndpoint, origin] of [
    [
      "explicit endpoint",
      "http://explicit.test/base",
      "http://service.test",
      "http://explicit.test",
    ],
    ["service endpoint", undefined, "http://service.test", "http://service.test"],
    ["AWS endpoint", undefined, undefined, "https://artifacts.s3.eu-west-1.amazonaws.com"],
  ] as const) {
    test(`retains ${name} and cloud authority after the initialization scope closes`, async () => {
      let requests = 0;
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          yield* assertNoInitialization;
          expect(url.origin).toBe(origin);
          expect(request.headers.authorization).toContain("Credential=initial/");
          expect(request.headers.authorization).toContain("/eu-west-1/s3/aws4_request");
          expect(request.headers["x-amz-security-token"]).toBe("test-session");
          requests++;
          return HttpClientResponse.fromWeb(request, new Response(null));
        }),
      );
      const head = await Effect.runPromise(
        initialize(
          Effect.gen(function* () {
            const bucket = yield* Bucket.ref("Artifacts", { stack: "test", stage: "test" });
            const bind = yield* makeBucketHttpBinding({
              tag: "AWS.S3.HeadObject",
              operation: S3.headObject,
              actions: ["s3:GetObject"],
            });
            return yield* bind(bucket).pipe(
              Effect.provideService(
                RuntimeContext,
                runtime({
                  [sanitizeKey(bucket.bucketName.toString())]: "artifacts",
                  [sanitizeKey(bucket.region.toString())]: "us-east-1",
                }),
              ),
            );
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provideService(
              Credentials,
              Config.String("ACCESS_KEY_ID").pipe(Effect.flatMap(credentials), Effect.orDie),
            ),
            Effect.provideService(Region, Config.String("REGION").pipe(Effect.orDie)),
            Effect.provideService(
              Endpoint,
              Config.String("ENDPOINT").pipe(
                Config.option,
                Effect.map(Option.getOrUndefined),
                Effect.orDie,
              ),
            ),
            Effect.provideService(ServiceEndpoint, { resolve: () => serviceEndpoint }),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                ACCESS_KEY_ID: "initial",
                REGION: "eu-west-1",
                ...(endpoint ? { ENDPOINT: endpoint } : {}),
              }),
            ),
          ),
        ),
      );
      await Effect.runPromise(head({ Key: "test.txt" }));
      expect(requests).toBe(1);
    });
  }

  test("keeps SDK policies and allows per-call authority overrides on native hosts", async () => {
    const plan = stack();
    const signingKeys = Effect.runSync(SigningKeyCache);
    let policyChecks = 0;
    let requests = 0;
    const policy = {
      while: () => {
        policyChecks++;
        return true;
      },
      schedule: Schedule.recurs(1),
    };
    const original = HttpClient.make(() => Effect.die("initial transport must be overridden"));
    const replacement = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        yield* assertNoInitialization;
        expect(yield* ResponseValidation).toBe("strict");
        expect(yield* SigningKeyCache).toBe(signingKeys);
        expect(Option.getOrUndefined(yield* Effect.serviceOption(ServerRetryHintCapMs))).toBe(0);
        expect(url.origin).toBe("http://call.test");
        expect(request.headers.authorization).toContain("Credential=call/");
        expect(request.headers.authorization).toContain("/ap-south-1/s3/aws4_request");
        requests++;
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: requests === 1 ? 503 : 200 }),
        );
      }),
    );
    const op = await Effect.runPromise(
      initialize(
        Effect.gen(function* () {
          const host = yield* NativeHost("Native", {});
          const op = yield* AWSBindings.withCredentials(S3.headObject).pipe(
            Effect.provideService(Self, host),
          );
          yield* AWSBindings.bind`test`({
            policyStatements: [
              { Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::artifacts/*"] },
            ],
          }).pipe(Effect.provideService(Self, host));
          return op;
        }).pipe(
          Effect.provide(
            Provider.succeed(NativeHost, {
              list: () => Effect.die("declaration must not list native hosts"),
              reconcile: () => Effect.die("declaration must not create a native host"),
              delete: () => Effect.die("declaration must not delete a native host"),
            }),
          ),
          Effect.provideService(StackContext, plan),
          Effect.provideService(HttpClient.HttpClient, original),
          Effect.provideService(Credentials, credentials("initial")),
          Effect.provideService(Region, Effect.succeed("us-east-1")),
          Effect.provideService(Endpoint, Effect.succeed("http://initial.test")),
          Effect.provideService(Retry, policy),
          Effect.provideService(ResponseValidation, "strict"),
          Effect.provideService(SigningKeyCache, signingKeys),
          Effect.provideService(ServerRetryHintCapMs, 0),
          Effect.provideService(RuntimeContext, runtime({})),
        ),
      ),
    );
    await Effect.runPromise(
      op({ Bucket: "artifacts", Key: "test.txt" }).pipe(
        Effect.provideService(HttpClient.HttpClient, replacement),
        Effect.provideService(Credentials, credentials("call")),
        Effect.provideService(Region, Effect.succeed("ap-south-1")),
        Effect.provideService(Endpoint, Effect.succeed("http://call.test")),
      ),
    );
    expect(requests).toBe(2);
    expect(policyChecks).toBe(1);
    expect(plan.bindings).toEqual({
      Native: [
        {
          sid: "Allow(Native, test)",
          data: {
            policyStatements: [
              { Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::artifacts/*"] },
            ],
          },
        },
      ],
    });
  });

  test("resolves an external host's least-privilege role before narrowing operation authority", async () => {
    const plan = stack();
    let initialScope: Scope.Scope | undefined;
    const requests: Array<{ url: URL; authorization: string | null }> = [];
    const fakeFetch: typeof globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const fiber = Fiber.getCurrent();
        if (fiber === undefined) throw new Error("fetch must execute in an Effect fiber");
        expect(Context.getOrUndefined(fiber.context, InitializationState)).toBeUndefined();
        expect(Context.getOrUndefined(fiber.context, RuntimeContext)).toBeUndefined();
        const scope = Context.getOrUndefined(fiber.context, Scope.Scope);
        expect(scope).not.toBe(initialScope);
        expect(scope?.state._tag).not.toBe("Closed");
        const url = new URL(input instanceof Request ? input.url : input);
        const headers = new Headers(init?.headers);
        requests.push({ url, authorization: headers.get("authorization") });
        if (headers.get("authorization")?.includes("/sts/aws4_request")) {
          const body =
            init?.body instanceof Uint8Array
              ? new TextDecoder().decode(init.body)
              : String(init?.body);
          expect(new URLSearchParams(body).get("RoleArn")).toBe(
            "arn:aws:iam::123456789012:role/ExternalRole",
          );
          return new Response(
            "<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>assumed</AccessKeyId><SecretAccessKey>assumed-secret</SecretAccessKey><SessionToken>assumed-session</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>",
          );
        }
        expect(url.origin).toBe("http://external.test");
        expect(headers.get("authorization")).toContain("Credential=assumed/");
        expect(headers.get("authorization")).toContain("/eu-west-1/s3/aws4_request");
        expect(headers.get("x-amz-security-token")).toBe("assumed-session");
        expect(headers.get("x-transport-option")).toBe("retained");
        return new Response(init?.method === "GET" ? "streamed-body" : null);
      },
      {
        preconnect: () => {
          throw new Error("preconnect is not scripted");
        },
      },
    );
    const { head, get } = await Effect.runPromise(
      initialize(
        Effect.gen(function* () {
          initialScope = yield* Effect.scope;
          const host = yield* ExternalHost("External", {});
          const bucket = yield* Bucket.ref("Artifacts", { stack: "test", stage: "test" });
          const bind = yield* makeBucketHttpBinding({
            tag: "AWS.S3.HeadObject",
            operation: S3.headObject,
            actions: ["s3:GetObject"],
          });
          return yield* Effect.all({
            head: bind(bucket),
            get: AWSBindings.withCredentials(
              S3.getObject,
              Effect.succeed(Effect.succeed("eu-west-1")),
            ),
          }).pipe(
            Effect.provideService(Self, host),
            Effect.provideService(
              RuntimeContext,
              runtime({
                [sanitizeKey(bucket.bucketName.toString())]: "artifacts",
                [sanitizeKey(bucket.region.toString())]: "eu-west-1",
                ExternalAccessKey_accessKeyId: "external-user",
                ExternalAccessKey_secretAccessKey: "external-secret",
                ExternalRole_roleArn: "arn:aws:iam::123456789012:role/ExternalRole",
                ALCHEMY_AWS_REGION: "us-east-1",
              }),
            ),
          );
        }).pipe(
          Effect.provide(
            Provider.succeed(ExternalHost, {
              list: () => Effect.die("declaration must not list external hosts"),
              reconcile: () => Effect.die("declaration must not create an external host"),
              delete: () => Effect.die("declaration must not delete an external host"),
            }),
          ),
          Effect.provideService(StackContext, plan),
          Effect.provideService(Credentials, credentials("deployer")),
          Effect.provideService(Region, Effect.succeed("ap-south-1")),
          Effect.provideService(Retry, { while: () => false }),
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
          Effect.provideService(FetchHttpClient.RequestInit, {
            headers: { "x-transport-option": "retained" },
          }),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ AWS_ENDPOINT_URL: "http://external.test" }),
          ),
        ),
      ),
    );
    expect(initialScope?.state._tag).toBe("Closed");
    await Effect.runPromise(head({ Key: "test.txt" }));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toContain("Credential=external-user/");
    expect(plan.bindings.External).toBeUndefined();
    expect(plan.bindings.ExternalRole).toHaveLength(1);
    expect(plan.bindings.ExternalRole?.[0]?.data.policyStatements).toEqual([
      { Effect: "Allow", Action: ["s3:GetObject"], Resource: expect.any(Array) },
    ]);
    expect(plan.resources.ExternalRole?.Type).toBe("AWS.IAM.Role");
    expect(Object.keys(plan.resources).sort()).toEqual([
      "External",
      "ExternalAccessKey",
      "ExternalRole",
      "ExternalUser",
    ]);

    const override = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        yield* assertNoInitialization;
        expect(url.origin).toBe("http://override.test");
        expect(request.headers.authorization).toContain("Credential=call/");
        expect(request.headers.authorization).toContain("/ap-south-1/s3/aws4_request");
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );
    await Effect.runPromise(
      head({ Key: "override.txt" }).pipe(
        Effect.provideService(HttpClient.HttpClient, override),
        Effect.provideService(Credentials, credentials("call")),
        Effect.provideService(Region, Effect.succeed("ap-south-1")),
        Effect.provideService(Endpoint, Effect.succeed("http://override.test")),
      ),
    );
    expect(requests).toHaveLength(2);

    // Consume the streaming response after both acquisition and execution return.
    const object = await Effect.runPromise(get({ Bucket: "artifacts", Key: "stream.txt" }));
    if (object.Body === undefined) throw new Error("Expected a streaming object body");
    const chunks = await Effect.runPromise(Stream.runCollect(object.Body));
    expect(chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")).toBe("streamed-body");
    expect(requests).toHaveLength(3);
  });

  test("isolates the compile-time native-host branch", async () => {
    const previous = globalThis.__ALCHEMY_NATIVE_HOST__;
    try {
      globalThis.__ALCHEMY_NATIVE_HOST__ = "AWS";
      const context = await Effect.runPromise(
        initialize(
          AWSBindings.withCredentials(Effect.context()).pipe(
            Effect.provideService(Credentials, credentials("native")),
            Effect.provideService(RuntimeContext, runtime({})),
          ),
        ),
      );
      expect(Context.getOrUndefined(context, InitializationState)).toBeUndefined();
      expect(Context.getOrUndefined(context, RuntimeContext)).toBeUndefined();
      expect(Context.getOrUndefined(context, Scope.Scope)).toBeUndefined();
      expect(Context.getOrUndefined(context, Credentials)).toBeDefined();
    } finally {
      globalThis.__ALCHEMY_NATIVE_HOST__ = previous;
    }
  });
});
