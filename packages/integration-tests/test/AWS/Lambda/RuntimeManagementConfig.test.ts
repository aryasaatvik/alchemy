import { fileURLToPath } from "node:url";
/**
 * Offline coverage for `runtimeManagementConfig`: the observe/put wire
 * requests and the provider diff's drift check, driven against an in-memory
 * Lambda runtime-management fake so the exact requests are pinned without a
 * cloud account.
 */
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Lambda from "@alchemy.run/aws/Lambda";
import { makeFunctionBundler } from "@alchemy.run/aws/Lambda/FunctionBundle";
import {
  observeRuntimeManagementConfig,
  syncRuntimeManagementConfig,
} from "@alchemy.run/aws/Lambda/RuntimeManagementConfig";
import { Docker } from "@alchemy.run/docker/Docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { mock as mockCredentials } from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";

const ACCOUNT_ID = "123456789012";
const FUNCTION_NAME = "runtime-fn";
const PINNED =
  "arn:aws:lambda:us-east-1::runtime:1111111111111111111111111111111111111111111111111111111111111111";
const OTHER =
  "arn:aws:lambda:us-east-1::runtime:2222222222222222222222222222222222222222222222222222222222222222";

const timeoutHandlerPath = fileURLToPath(new URL("./timeout-handler.ts", import.meta.url));

interface ObservedConfig {
  UpdateRuntimeOn?: string;
  RuntimeVersionArn?: string;
}

/** One function's runtime-management config served over a fake client. */
const makeCloud = (initial: ObservedConfig) => {
  let config = initial;
  const puts: Array<Record<string, unknown>> = [];
  const qualifiers: Array<string | null> = [];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const raw = request.body as { body?: Uint8Array };
      const body = new TextDecoder().decode(raw.body ?? new Uint8Array());
      qualifiers.push(url.searchParams.get("Qualifier"));
      const path = `/2021-07-20/functions/${FUNCTION_NAME}/runtime-management-config`;
      if (url.pathname !== path) {
        throw new Error(`unexpected Lambda request ${request.method} ${url.pathname}`);
      }
      const functionArn = `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:${FUNCTION_NAME}`;
      if (request.method === "GET") {
        return HttpClientResponse.fromWeb(
          request,
          json(200, { ...config, FunctionArn: functionArn }),
        );
      }
      if (request.method === "PUT") {
        const put = JSON.parse(body) as Record<string, unknown>;
        puts.push(put);
        config = {
          UpdateRuntimeOn: put.UpdateRuntimeOn as string,
          RuntimeVersionArn: put.RuntimeVersionArn as string | undefined,
        };
        return HttpClientResponse.fromWeb(
          request,
          json(200, { ...config, FunctionArn: functionArn }),
        );
      }
      throw new Error(`unexpected Lambda request ${request.method}`);
    }),
  );

  const layer = Layer.mergeAll(
    mockCredentials,
    Region.of("us-east-1"),
    Layer.succeed(HttpClient.HttpClient, client),
    // Zip functions never build images; any Docker call is a test bug.
    Layer.succeed(Docker, {} as Docker["Service"]),
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        credentials: Effect.die("offline test must not resolve credentials"),
      }),
    ),
  );

  return { puts, qualifiers, layer, current: () => config };
};

const { test } = Test.make({
  providers: Lambda.FunctionProvider().pipe(Layer.provide(makeCloud({}).layer)),
});

const tags = ["unit", "provider:aws", "provider:aws:lambda", "local"];

test.provider(
  "observes AWS's default when Lambda reports no update mode",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({});
      const observed = yield* observeRuntimeManagementConfig(FUNCTION_NAME).pipe(
        Effect.provide(cloud.layer),
      );
      expect(observed).toEqual({ updateRuntimeOn: "Auto" });
    }),
  { tags },
);

test.provider(
  "pins a runtime version and skips the put once converged",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({ UpdateRuntimeOn: "Auto" });
      const desired = {
        updateRuntimeOn: "Manual",
        runtimeVersionArn: PINNED,
      } as const;
      const pinned = yield* syncRuntimeManagementConfig({
        functionName: FUNCTION_NAME,
        desired,
      }).pipe(Effect.provide(cloud.layer));
      expect(pinned).toEqual(desired);
      expect(cloud.puts).toEqual([{ UpdateRuntimeOn: "Manual", RuntimeVersionArn: PINNED }]);

      yield* syncRuntimeManagementConfig({
        functionName: FUNCTION_NAME,
        desired,
      }).pipe(Effect.provide(cloud.layer));
      expect(cloud.puts).toHaveLength(1);
    }),
  { tags },
);

test.provider(
  "returns an unset config to Auto without a runtime version ARN",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({
        UpdateRuntimeOn: "Manual",
        RuntimeVersionArn: PINNED,
      });
      yield* syncRuntimeManagementConfig({
        functionName: FUNCTION_NAME,
        desired: undefined,
      }).pipe(Effect.provide(cloud.layer));
      expect(cloud.puts).toEqual([{ UpdateRuntimeOn: "Auto" }]);
      expect(cloud.current()).toEqual({ UpdateRuntimeOn: "Auto" });
    }),
  { tags },
);

test.provider(
  "diff updates a function whose live runtime drifted from its pin",
  () =>
    Effect.gen(function* () {
      const props = {
        main: timeoutHandlerPath,
        handler: "handler",
        isExternal: true,
        functionUrl: false,
        runtimeManagementConfig: {
          updateRuntimeOn: "Manual",
          runtimeVersionArn: PINNED,
        },
      } satisfies Lambda.FunctionProps;
      const provider = yield* Provider.findProvider(Lambda.Function);
      const { bundleCode } = yield* makeFunctionBundler;
      const { identityHash } = yield* bundleCode("RuntimeFn", props);
      const output = {
        functionArn: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:${FUNCTION_NAME}`,
        functionName: FUNCTION_NAME,
        functionUrl: undefined,
        roleName: "runtime-fn-role",
        roleArn: `arn:aws:iam::${ACCOUNT_ID}:role/runtime-fn-role`,
        code: { hash: identityHash },
      };
      const diff = (live: ObservedConfig) =>
        provider.diff!({
          id: "RuntimeFn",
          fqn: "RuntimeFn",
          instanceId: "0123456789abcdef0123456789abcdef",
          olds: props,
          news: props,
          output,
          oldBindings: [],
          newBindings: [],
        } as any).pipe(Effect.provide(makeCloud(live).layer));

      expect(yield* diff({ UpdateRuntimeOn: "Manual", RuntimeVersionArn: PINNED })).toEqual({
        action: "noop",
      });
      expect(yield* diff({ UpdateRuntimeOn: "Manual", RuntimeVersionArn: OTHER })).toEqual({
        action: "update",
      });
      expect(yield* diff({ UpdateRuntimeOn: "Auto" })).toEqual({
        action: "update",
      });
    }),
  { tags, timeout: 60_000 },
);

test.provider(
  "removing a pin resets the exact serving version to Auto",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({ UpdateRuntimeOn: "Manual", RuntimeVersionArn: PINNED });
      yield* syncRuntimeManagementConfig({
        functionName: FUNCTION_NAME,
        qualifier: "7",
        desired: undefined,
      }).pipe(Effect.provide(cloud.layer));
      expect(cloud.qualifiers).toEqual(["7", "7"]);
      expect(cloud.puts).toEqual([{ UpdateRuntimeOn: "Auto" }]);
    }),
  { tags },
);

const versionArn = `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:${FUNCTION_NAME}`;
const versionedConfig = {
  FunctionName: FUNCTION_NAME,
  FunctionArn: versionArn,
  CodeSha256: "published-code",
  Runtime: "nodejs24.x",
  State: "Active",
  LastUpdateStatus: "Successful",
};

const { test: releaseTest } = Test.make({
  providers: Layer.mergeAll(
    Lambda.VersionProvider(),
    Lambda.AliasProvider(),
    Provider.succeed(Lambda.Function, {
      reconcile: () =>
        Effect.succeed({
          functionName: FUNCTION_NAME,
          functionArn: versionArn,
          qualifiedArn: versionArn,
          roleName: "role",
          roleArn: `arn:aws:iam::${ACCOUNT_ID}:role/role`,
          functionUrl: undefined,
          code: { hash: "published-code" },
          runtimeManagementConfig: {
            updateRuntimeOn: "Manual" as const,
            runtimeVersionArn: PINNED,
          },
        }),
      delete: () => Effect.void,
    }),
  ).pipe(Layer.provide(makeCloud({}).layer)),
});

releaseTest.provider(
  "the separate Version resource pins its numbered version before Alias promotion",
  (stack) =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const http = HttpClient.make((request, url) =>
        Effect.sync(() => {
          const path = url.pathname;
          const qualifier = url.searchParams.get("Qualifier");
          const body =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : {};
          const json = (value: object, status = 200) =>
            HttpClientResponse.fromWeb(
              request,
              Response.json(value, {
                status,
                ...(status === 404
                  ? { headers: { "x-amzn-errortype": "ResourceNotFoundException" } }
                  : {}),
              }),
            );
          if (request.method === "GET" && path.endsWith("/configuration"))
            return json(versionedConfig);
          if (path.endsWith("/versions")) {
            if (request.method === "GET") return json({ Versions: [] });
            writes.push("publish:7");
            return json({ ...versionedConfig, Version: "7", Description: body.Description }, 201);
          }
          if (path.endsWith("/runtime-management-config")) {
            if (request.method === "GET")
              return json({ UpdateRuntimeOn: "Auto", FunctionArn: versionArn });
            expect(body.RuntimeVersionArn).toBe(PINNED);
            writes.push(`pin:${qualifier}`);
            return json({ ...body, FunctionArn: versionArn });
          }
          if (path.endsWith("/aliases")) {
            writes.push(`promote:${body.FunctionVersion}`);
            return json({ ...body, AliasArn: `${versionArn}:live` }, 201);
          }
          if (path.includes("/event-invoke-config") || path.endsWith("/aliases/live"))
            return json({}, request.method === "DELETE" ? 200 : 404);
          throw new Error(`unexpected Lambda request ${request.method} ${path}`);
        }),
      );
      const alias = yield* stack
        .deploy(
          Effect.gen(function* () {
            const fn = yield* Lambda.Function("PublishHost", { main: timeoutHandlerPath });
            const version = yield* Lambda.Version("Published", { function: fn });
            return yield* Lambda.Alias("Serving", { version, aliasName: "live" });
          }),
        )
        .pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect(alias.functionVersion).toBe("7");
      expect(writes).toEqual(["publish:7", "pin:7", "promote:7"]);
      yield* stack.destroy().pipe(Effect.provideService(HttpClient.HttpClient, http));
    }),
  { tags: ["unit", "local", "provider:aws:lambda"] },
);
