/**
 * Offline coverage for `AWS.Lambda.Function`'s precreate stub.
 *
 * Precreate runs against UNRESOLVED props: a layer built in the same deploy
 * (e.g. `layers: [managedArn, collectorConfigLayer]`) is still an Output
 * when the stub is created. These tests drive the provider against an
 * in-memory IAM + Lambda fake, so they pin the exact requests without a
 * cloud account.
 */
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Docker } from "@/Docker/Docker.ts";
import * as Lambda from "@/AWS/Lambda";
import { InstanceId } from "@/InstanceId.ts";
import * as Output from "@/Output.ts";
import * as Provider from "@/Provider.ts";
import * as Test from "@/Test/Alchemy";
import { mock as mockCredentials } from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const ACCOUNT_ID = "123456789012";
const MANAGED_LAYER =
  "arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-collector-amd64-ver-0-102-1:1";

/** In-memory IAM + Lambda account served over a fake HTTP client. */
const makeCloud = (options: { failCreateFunction?: boolean } = {}) => {
  const roles = new Map<string, Set<string>>();
  const functions = new Set<string>();
  const createFunctionBodies: Array<Record<string, unknown>> = [];

  const xml = (body: string, status = 200) =>
    new Response(body, { status, headers: { "content-type": "text/xml" } });
  const iamXml = (action: string, result = "") =>
    xml(
      `<${action}Response xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></${action}Response>`,
    );
  const roleXml = (roleName: string) =>
    `<Role><Path>/</Path><RoleName>${roleName}</RoleName><RoleId>AROATEST</RoleId><Arn>arn:aws:iam::${ACCOUNT_ID}:role/${roleName}</Arn><CreateDate>2026-01-01T00:00:00Z</CreateDate></Role>`;

  const handleIam = (params: URLSearchParams) => {
    const action = params.get("Action")!;
    const roleName = params.get("RoleName") ?? "";
    const policies = roles.get(roleName);
    if (action !== "CreateRole" && policies === undefined) {
      return xml(
        `<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>NoSuchEntity</Code><Message>not found</Message></Error><RequestId>r</RequestId></ErrorResponse>`,
        404,
      );
    }
    switch (action) {
      case "GetRole":
        return iamXml(action, roleXml(roleName));
      case "CreateRole":
        roles.set(roleName, new Set());
        return iamXml(action, roleXml(roleName));
      case "AttachRolePolicy":
        policies!.add(params.get("PolicyArn")!);
        return iamXml(action);
      case "DetachRolePolicy":
        policies!.delete(params.get("PolicyArn")!);
        return iamXml(action);
      case "ListAttachedRolePolicies":
        return iamXml(
          action,
          `<AttachedPolicies>${[...policies!]
            .map(
              (arn) =>
                `<member><PolicyName>${arn.split("/").pop()}</PolicyName><PolicyArn>${arn}</PolicyArn></member>`,
            )
            .join("")}</AttachedPolicies><IsTruncated>false</IsTruncated>`,
        );
      case "DeleteRole":
        roles.delete(roleName);
        return iamXml(action);
      default:
        throw new Error(`unexpected IAM action ${action}`);
    }
  };

  const lambdaJson = (status: number, body: unknown, errorType?: string) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        ...(errorType ? { "x-amzn-errortype": errorType } : {}),
      },
    });

  const handleLambda = (method: string, pathname: string, body: string) => {
    if (method === "POST" && pathname === "/2015-03-31/functions") {
      const request = JSON.parse(body) as Record<string, unknown>;
      createFunctionBodies.push(request);
      if (options.failCreateFunction) {
        return lambdaJson(
          400,
          { message: "stub rejected" },
          "InvalidParameterValueException",
        );
      }
      const name = request.FunctionName as string;
      functions.add(name);
      return lambdaJson(201, {
        FunctionName: name,
        FunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:${name}`,
      });
    }
    const get = pathname.match(/^\/2015-03-31\/functions\/([^/]+)$/);
    if (method === "GET" && get) {
      return functions.has(decodeURIComponent(get[1]!))
        ? lambdaJson(200, { Configuration: {} })
        : lambdaJson(
            404,
            { message: "not found" },
            "ResourceNotFoundException",
          );
    }
    throw new Error(`unexpected Lambda request ${method} ${pathname}`);
  };

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const raw = request.body as { body?: Uint8Array };
      const body = new TextDecoder().decode(raw.body ?? new Uint8Array());
      const response = url.hostname.startsWith("iam.")
        ? handleIam(new URLSearchParams(body))
        : handleLambda(request.method, url.pathname, body);
      return HttpClientResponse.fromWeb(request, response);
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

  return { roles, functions, createFunctionBodies, layer };
};

const { test } = Test.make({
  providers: Lambda.FunctionProvider().pipe(Layer.provide(makeCloud().layer)),
});

/** A layer created in the same deploy: unresolved while precreate runs. */
const collectorConfigLayer = Output.of({
  Type: "AWS.Lambda.LayerVersion",
  LogicalId: "CollectorConfig",
  FQN: "CollectorConfig",
  Namespace: undefined,
} as any) as unknown as Lambda.LayerRef;

const precreate = (
  id: string,
  cloud: ReturnType<typeof makeCloud>,
  layers: Lambda.LayerRef[] = [],
) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Lambda.Function);
    return yield* provider.precreate!({
      id,
      fqn: id,
      instanceId: "0123456789abcdef0123456789abcdef",
      news: {
        main: "./handler.ts",
        layers,
      } as any,
      bindings: [],
      session: { note: () => Effect.void } as any,
    }).pipe(
      Effect.provideService(InstanceId, "0123456789abcdef0123456789abcdef"),
      // The engine provides the stack's cloud services at the call site.
      Effect.provide(cloud.layer),
    );
  });

test.provider(
  "precreate omits Layers while a layer is still an unresolved Output",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud();
      const output = yield* precreate("LayeredStub", cloud, [
        MANAGED_LAYER,
        collectorConfigLayer,
      ]);

      expect(cloud.createFunctionBodies).toHaveLength(1);
      // Reconcile attaches the resolved layer set; the stub sends no key.
      expect(cloud.createFunctionBodies[0]).not.toHaveProperty("Layers");
      expect(cloud.functions.has(output.functionName)).toBe(true);
      expect(cloud.roles.has(output.roleName)).toBe(true);
    }),
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
);

test.provider(
  "a failed precreate releases the execution role it created",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({ failCreateFunction: true });
      const exit = yield* Effect.exit(precreate("FailedStub", cloud));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(cloud.createFunctionBodies).toHaveLength(1);
      // No function exists, so destroy's recovery `read` finds nothing and
      // drops the row — the role must not outlive the failed precreate.
      expect(cloud.functions.size).toBe(0);
      expect([...cloud.roles.keys()]).toEqual([]);
    }),
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
);
