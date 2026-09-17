import type { CloudflareResolvedCredentials } from "@/Cloudflare/Auth/AuthProvider.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import {
  type Record,
  RecordProvider,
  type RecordAttributes,
  type RecordProps,
} from "@/Cloudflare/DNS/Record.ts";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { InstanceId } from "@/InstanceId.ts";
import * as Output from "@/Output.ts";
import { Provider } from "@/Provider.ts";
import type { ResourceLike } from "@/Resource.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

// Diff-level regression tests for DNS record identity. Two failure modes,
// both of which delete and recreate a live record:
//
//   1. Cloudflare stores names as lowercase FQDNs without a trailing dot, so
//      a raw string comparison reads `_Acme.Example.com.` as a rename.
//   2. A record's name/type can be derived from another resource's Outputs
//      (an ACM validation record, an SES DKIM record, a SaaS custom-hostname
//      verification TXT). Comparing an unresolved expression — or an
//      expression-shaped persisted prop — against a concrete prior identity
//      reads as a rename too.
//
// A live suite can never catch either: a fresh deploy writes props and
// attributes in the same canonical, already-resolved shape. These tests hand
// the real provider `diff` the states that only occur on a *second* deploy.

const TEST_ACCOUNT = "test-account-id";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const RECORD_ID = "372e67954025e0ba6aaa6d586b9e0b59";

const stack: Omit<StackSpec, "output"> = {
  name: "my-stack",
  stage: "dev",
  resources: {},
  bindings: {},
  actions: {},
};

const credentials: CloudflareResolvedCredentials = {
  type: "apiToken",
  apiToken: Redacted.make("test-token"),
  accountId: TEST_ACCOUNT,
  source: { type: "env" },
};

// `diff` touches no services; these only satisfy the provider layer's
// type-level requirements.
const env = Layer.mergeAll(
  Layer.succeed(CloudflareEnvironment, Effect.succeed(credentials)),
  Layer.succeed(Stack, stack),
  Layer.succeed(Stage, stack.stage),
  Layer.succeed(InstanceId, "0123456789abcdef0123456789abcdef"),
  Layer.succeed(AlchemyContext, {
    dotAlchemy: "/tmp/.alchemy-test",
    dev: false,
    adopt: false,
  }),
  Layer.succeed(
    Credentials,
    Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
  ),
  NodeServices.layer,
  FetchHttpClient.layer,
);

const diffInput = (input: {
  olds?: Partial<RecordProps>;
  news: Partial<RecordProps>;
  output?: RecordAttributes;
}) => ({
  id: "ValidationRecord",
  fqn: "ValidationRecord",
  instanceId: "0123456789abcdef0123456789abcdef",
  olds: input.olds as never,
  news: input.news as never,
  output: input.output as never,
  oldBindings: [] as never,
  newBindings: [] as never,
});

const diff = (input: Parameters<typeof diffInput>[0]) =>
  Effect.gen(function* () {
    const provider = yield* Provider<Record>("Cloudflare.DNS.Record");
    return yield* provider.diff!(diffInput(input));
  }).pipe(Effect.provide(RecordProvider()), Effect.provide(env));

const attributes = (
  overrides: Partial<RecordAttributes> = {},
): RecordAttributes => ({
  recordId: RECORD_ID,
  zoneId: ZONE,
  name: "_acme-challenge.example.com",
  type: "TXT",
  content: "token-value",
  ttl: 1,
  proxied: false,
  createdOn: undefined,
  modifiedOn: undefined,
  ...overrides,
});

/** An Output expression that only resolves at apply — never a plain string. */
const unresolvedName = () => {
  const source: ResourceLike<"ACM.Certificate", any, { name: string }> = {
    Type: "ACM.Certificate",
    FQN: "Cert",
    LogicalId: "Cert",
    Namespace: undefined,
  } as any;
  return (Output.of(source) as any).name as unknown as string;
};

describe("Cloudflare DNS record diff: canonical names", () => {
  it.effect("a trailing root dot and case are not a rename", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: {
          zoneId: ZONE,
          name: "_Acme-Challenge.Example.com.",
          type: "TXT",
          content: "token-value",
        },
        news: {
          zoneId: ZONE,
          name: "_acme-challenge.example.com",
          type: "TXT",
          content: "token-value",
        },
      });
      expect(result?.action).not.toBe("replace");
    }),
  );

  it.effect("a genuinely different name still replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: {
          zoneId: ZONE,
          name: "_acme-challenge.example.com",
          type: "TXT",
          content: "token-value",
        },
        news: {
          zoneId: ZONE,
          name: "_acme-challenge.other.example.com",
          type: "TXT",
          content: "token-value",
        },
      });
      expect(result?.action).toBe("replace");
    }),
  );

  it.effect("a different type still replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: {
          zoneId: ZONE,
          name: "_acme-challenge.example.com",
          type: "TXT",
          content: "token-value",
        },
        news: {
          zoneId: ZONE,
          name: "_acme-challenge.example.com",
          type: "CNAME",
          content: "token-value",
        },
      });
      expect(result?.action).toBe("replace");
    }),
  );
});

describe("Cloudflare DNS record diff: unresolved identity", () => {
  it.effect("an Output-derived name defers to the generic planner", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: {
          zoneId: ZONE,
          name: "_acme-challenge.example.com",
          type: "TXT",
          content: "token-value",
        },
        news: {
          zoneId: ZONE,
          name: unresolvedName(),
          type: "TXT",
          content: "token-value",
        },
        output: attributes(),
      });
      expect(result).toBeUndefined();
    }),
  );

  it.effect("an Output-derived content also defers", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: {
          zoneId: ZONE,
          name: "_acme-challenge.example.com",
          type: "TXT",
          content: "token-value",
        },
        news: {
          zoneId: ZONE,
          name: "renamed.example.com",
          type: "TXT",
          content: unresolvedName(),
        },
        output: attributes(),
      });
      expect(result).toBeUndefined();
    }),
  );
});

describe("Cloudflare DNS record diff: observed identity wins", () => {
  it.effect("absent props fall back to the observed record", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        // Derived identity was stripped from persisted props.
        olds: { zoneId: ZONE, content: "token-value" },
        news: {
          zoneId: ZONE,
          name: "_ACME-Challenge.example.com.",
          type: "TXT",
          content: "token-value",
        },
        output: attributes(),
      });
      expect(result?.action).not.toBe("replace");
    }),
  );

  it.effect("stale props do not replace a matching observed record", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: {
          zoneId: ZONE,
          name: "stale-from-a-previous-generation.example.com",
          type: "CNAME",
          content: "token-value",
        },
        news: {
          zoneId: ZONE,
          name: "_acme-challenge.example.com",
          type: "TXT",
          content: "token-value",
        },
        output: attributes(),
      });
      expect(result?.action).not.toBe("replace");
    }),
  );

  it.effect("a genuinely different observed name still replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { zoneId: ZONE, content: "token-value" },
        news: {
          zoneId: ZONE,
          name: "_acme-challenge.example.com",
          type: "TXT",
          content: "token-value",
        },
        output: attributes({ name: "someone-elses-record.example.com" }),
      });
      expect(result?.action).toBe("replace");
    }),
  );

  it.effect("a genuinely different observed zone still replaces", () =>
    Effect.gen(function* () {
      const result = yield* diff({
        olds: { content: "token-value" },
        news: {
          zoneId: ZONE,
          name: "_acme-challenge.example.com",
          type: "TXT",
          content: "token-value",
        },
        output: attributes({ zoneId: "0000000000000000000000000000ffff" }),
      });
      expect(result?.action).toBe("replace");
    }),
  );
});
