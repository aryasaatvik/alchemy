import { createHash } from "node:crypto";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import {
  makeDynamoDBState,
  createStateTableName,
  createOverflowBucketName,
} from "@alchemy.run/aws/StateStore/DynamoDBState";
import { stateEncryption } from "@alchemy.run/aws/StateStore/Encryption";
import { stateEnvironment } from "@alchemy.run/aws/StateStore/State";
import { expect, test } from "@alchemy.run/test";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import type { ResourceState } from "alchemy/State/ResourceState";
import { isResourceState } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { isSealed } from "alchemy/State/StateEncryption";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const endpoint = process.env.ALCHEMY_STATE_PROOF_FLOCI_URL;
const region = "us-east-1";
const accountId = "000000000000";
const stage = { stack: "StateEncryptionFixture", stage: "existing" };
const s = (value: string) => ({ S: value });
const recordKey = (fqn: string) => ({
  PK: s(`STAGE#${stage.stack}#${stage.stage}`),
  SK: s(`RECORD#${createHash("sha256").update(fqn).digest("hex")}`),
});
const formatKey = { PK: s("STORE"), SK: s("FORMAT") };
const leaseKey = { PK: s(`STAGE#${stage.stack}#${stage.stage}`), SK: s("LEASE") };
const keyFields = {
  PK: Schema.Struct({ S: Schema.String }),
  SK: Schema.Struct({ S: Schema.String }),
};
const putItem = Schema.decodeUnknownEffect(
  Schema.Struct({
    Item: Schema.Struct({
      ...keyFields,
      fqn: Schema.optional(Schema.Struct({ S: Schema.String })),
    }),
  }),
);
const deleteItem = Schema.decodeUnknownEffect(Schema.Struct({ Key: Schema.Struct(keyFields) }));

const record = (fqn: string, visible = fqn): ResourceState => ({
  resourceType: "test:resource",
  namespace: undefined,
  fqn,
  logicalId: fqn,
  instanceId: fqn,
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: {},
  attr: { secret: Redacted.make(`fixture-${fqn}`), visible },
});

const expectReadback = (actual: unknown, expected: ResourceState) =>
  expect(encodeState(actual)).toEqual(encodeState(expected));

test.live.skipIf(endpoint === undefined)(
  "first load converts legacy DynamoDB state and resumes after an interrupted reseal",
  () =>
    Effect.gen(function* () {
      const url = new URL(endpoint!);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/"
      ) {
        throw new Error("Use an isolated Floci container on an explicit 127.0.0.1 port");
      }

      const calls: string[] = [];
      const keySpecs: Array<{ KeyUsage: unknown; KeySpec: unknown }> = [];
      const leaseWrites: Array<{ operation: string; key: typeof leaseKey }> = [];
      let cutReseal = false;
      const firstCommitted = Promise.withResolvers<void>();
      const transport: typeof globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const target = new URL(request.url);
          if (target.origin !== url.origin) throw new Error(`Unexpected origin ${target.origin}`);
          const op =
            request.headers.get("x-amz-target")?.split(".").at(-1) ??
            `${request.method} ${target.searchParams.has("encryption") ? "encryption" : "s3"}`;
          calls.push(op);
          let row: string | undefined;
          if (op === "CreateKey") {
            const { KeyUsage, KeySpec } = await request.clone().json();
            keySpecs.push({ KeyUsage, KeySpec });
          } else if (op === "PutItem") {
            const {
              Item: { PK, SK, fqn },
            } = await Effect.runPromise(putItem(await request.clone().json()));
            if (SK.S === "LEASE") leaseWrites.push({ operation: op, key: { PK, SK } });
            if (cutReseal) row = fqn?.S;
          } else if (op === "DeleteItem") {
            const { Key } = await Effect.runPromise(deleteItem(await request.clone().json()));
            if (Key.SK.S === "LEASE") leaseWrites.push({ operation: op, key: Key });
          }
          if (row === "Second") {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              const committed = await Promise.race([
                firstCommitted.promise.then(() => true),
                new Promise<false>((resolve) => {
                  timeout = setTimeout(() => resolve(false), 5_000);
                }),
              ]);
              return Response.json(
                {
                  __type: "ValidationException",
                  message: committed
                    ? "fixture interrupted reseal"
                    : "fixture expected First to commit while Second was held",
                },
                { status: 400 },
              );
            } finally {
              clearTimeout(timeout);
            }
          }
          const response = await fetch(request, { redirect: "error" });
          if (row === "First" && response.ok) firstCommitted.resolve();
          return response;
        },
        { preconnect: globalThis.fetch.preconnect },
      );
      const environment = Layer.succeed(
        AWSEnvironment,
        Effect.succeed({
          accountId,
          region,
          endpoint: url.origin,
          credentials: Effect.succeed({
            accessKeyId: Redacted.make("test"),
            secretAccessKey: Redacted.make("test"),
            sessionToken: undefined,
            region,
          }),
        }),
      );

      yield* Effect.gen(function* () {
        for (const disable of [false, true]) {
          // A distinct name proves the decrypt-only layer resolves a missing key.
          const name = disable ? "decrypt-only" : undefined;
          const table = createStateTableName(name);
          const bucket = createOverflowBucketName(accountId, region, name);
          const options = { name, migrateFrom: false, overflowThreshold: 1024 } as const;
          const store = disable
            ? makeDynamoDBState(options).pipe(Effect.provide(stateEncryption({ disable: true })))
            : makeDynamoDBState(options);
          const alias = `alias/alchemy-state${name ? `-${name}` : ""}`;
          const first = record("First");
          const second = record("Second");
          const getItem = (Key: Record<string, dynamodb.AttributeValue>) =>
            dynamodb
              .getItem({ TableName: table, Key, ConsistentRead: true })
              .pipe(Effect.map((result) => result.Item));

          yield* dynamodb.createTable({
            TableName: table,
            BillingMode: "PAY_PER_REQUEST",
            AttributeDefinitions: [
              { AttributeName: "PK", AttributeType: "S" },
              { AttributeName: "SK", AttributeType: "S" },
            ],
            KeySchema: [
              { AttributeName: "PK", KeyType: "HASH" },
              { AttributeName: "SK", KeyType: "RANGE" },
            ],
          });
          yield* s3.createBucket({ Bucket: bucket });
          for (const value of [first, second]) {
            yield* dynamodb.putItem({
              TableName: table,
              Item: {
                ...recordKey(value.fqn),
                fqn: s(value.fqn),
                data: s(JSON.stringify(encodeState(value))),
              },
            });
          }
          expect(yield* getItem(formatKey)).toBeUndefined();
          calls.length = 0;
          keySpecs.length = 0;
          leaseWrites.length = 0;

          const readStage = Effect.scoped(
            Effect.gen(function* () {
              const state = yield* store;
              for (const value of [first, second]) {
                expectReadback(yield* state.get({ ...stage, fqn: value.fqn }), value);
              }
            }),
          );

          if (disable) {
            yield* readStage;
          } else {
            cutReseal = true;
            const failed = yield* readStage.pipe(Effect.flip);
            cutReseal = false;
            expect(failed.message).toContain("fixture interrupted reseal");
            expect(isSealed((yield* getItem(recordKey(first.fqn)))?.data?.S ?? "")).toBe(true);
            expect((yield* getItem(recordKey(second.fqn)))?.data?.S).toContain("fixture-Second");
          }

          const firstAccess = [...calls];
          for (const op of [
            "DescribeKey",
            "CreateKey",
            "CreateAlias",
            "EnableKeyRotation",
            "UpdateTable",
            "PUT encryption",
            "PutItem",
            "DeleteItem",
          ]) {
            expect(firstAccess).toContain(op);
          }
          expect(firstAccess.includes("GenerateDataKey")).toBe(!disable);
          expect(firstAccess).not.toContain("Decrypt");
          expect(keySpecs).toEqual([{ KeyUsage: "ENCRYPT_DECRYPT", KeySpec: "SYMMETRIC_DEFAULT" }]);
          expect(leaseWrites).toEqual([
            { operation: "PutItem", key: leaseKey },
            { operation: "DeleteItem", key: leaseKey },
          ]);
          expect(yield* getItem(leaseKey)).toBeUndefined();
          expect((yield* getItem(formatKey))?.format?.N).toBe("1");

          const key = (yield* kms.describeKey({ KeyId: alias })).KeyMetadata?.Arn;
          expect(key).toBeDefined();
          expect((yield* kms.getKeyRotationStatus({ KeyId: key! })).KeyRotationEnabled).toBe(true);
          const rule = (yield* s3.getBucketEncryption({ Bucket: bucket }))
            .ServerSideEncryptionConfiguration?.Rules?.[0];
          const defaults = rule?.ApplyServerSideEncryptionByDefault;
          expect(defaults?.SSEAlgorithm).toBe("aws:kms");
          const bucketKey = defaults?.KMSMasterKeyID;
          expect(Redacted.isRedacted(bucketKey) ? Redacted.value(bucketKey) : bucketKey).toBe(key);
          expect(rule?.BucketKeyEnabled).toBe(true);
          const description = (yield* dynamodb.describeTable({ TableName: table })).Table
            ?.SSEDescription;
          expect(description?.KMSMasterKeyArn).toBe(key);
          yield* Effect.logInfo(
            `${disable ? "decrypt-only" : "default"}: ${firstAccess.join(" ")}`,
          );

          calls.length = 0;
          yield* readStage;
          if (disable) {
            expect(calls).not.toContain("Decrypt");
            expect(calls).not.toContain("GenerateDataKey");
          } else {
            expect(calls).toContain("Decrypt");
          }
          for (const value of [first, second]) {
            const text = (yield* getItem(recordKey(value.fqn)))?.data?.S ?? "";
            expect(isSealed(text)).toBe(!disable);
            expect(text.includes(`fixture-${value.fqn}`)).toBe(disable);
          }

          const overflow = record("Overflow", "x".repeat(2048));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const state = yield* store;
              yield* state.set({ ...stage, fqn: overflow.fqn, value: overflow });
            }),
          );
          const ref = (yield* getItem(recordKey(overflow.fqn)))?.ref?.S;
          expect(ref).toBeDefined();
          const body = (yield* s3.getObject({ Bucket: bucket, Key: ref! })).Body!;
          expect(isSealed(yield* body.pipe(Stream.decodeText, Stream.mkString))).toBe(!disable);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const state = yield* store;
              const value = yield* state.get({ ...stage, fqn: overflow.fqn });
              expect(isResourceState(value)).toBe(true);
              expectReadback(value, overflow);
            }),
          );
        }
      }).pipe(
        Effect.provide(stateEnvironment().pipe(Layer.provide(environment))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, transport),
        Effect.provide(ProfileStoreLive),
        Effect.provide(PlatformServices),
        Effect.provideService(AuthProviders, {}),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ CI: "false" }),
        ),
      );
    }),
  { tags: ["local", "provider:aws", "provider:aws:statestore"], timeout: 60_000, retry: 0 },
);
