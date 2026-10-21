import {
  CloudflareEnvironment,
  runtimeIdentity,
} from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { Flag, FlagProvider, type FlagRule } from "@alchemy.run/cloudflare/Flagship/Flag";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const accountId = "0123456789abcdef0123456789abcdef";
const bodySchema = Schema.Struct({
  key: Schema.String,
  enabled: Schema.Boolean,
  default_variation: Schema.String,
  variations: Schema.Record(Schema.String, Schema.Unknown),
  description: Schema.optional(Schema.String),
  rules: Schema.Array(
    Schema.Struct({
      priority: Schema.Number,
      conditions: Schema.Array(Schema.Unknown),
      serve_variation: Schema.String,
    }),
  ),
});
let live: typeof bodySchema.Type | undefined;
const writes: (typeof bodySchema.Type)[] = [];
const externalRules = [{ priority: 1, conditions: [], serve_variation: "on" }];

const client = HttpClient.make((request, url) =>
  Effect.sync(() => {
    if (!url.pathname.startsWith(`/client/v4/accounts/${accountId}/flagship/apps/app/flags`)) {
      throw new Error(`Unscripted flag request: ${request.method} ${url}`);
    }
    if (request.method === "DELETE") {
      live = undefined;
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ success: true, result: { key: "flag" } }),
      );
    }
    if (request.method === "GET" && live === undefined) {
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          { success: false, errors: [{ code: 1000, message: "Flag not found" }] },
          { status: 404 },
        ),
      );
    }
    if (request.method === "POST" || request.method === "PUT") {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON flag request");
      live = Schema.decodeUnknownSync(bodySchema)(
        JSON.parse(new TextDecoder().decode(request.body.body)),
      );
      writes.push(live);
    } else if (request.method !== "GET") {
      throw new Error(`Unscripted flag method: ${request.method}`);
    }
    return HttpClientResponse.fromWeb(
      request,
      Response.json({ success: true, result: { ...live, type: "boolean" } }),
    );
  }),
);

const providers = FlagProvider().pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(CloudflareEnvironment, Effect.succeed(runtimeIdentity(accountId))),
      Layer.succeed(
        Credentials,
        Effect.succeed(
          apiTokenCredentials({
            apiToken: Redacted.make("fixture"),
            apiBaseUrl: "https://api.cloudflare.test/client/v4",
          }),
        ),
      ),
      Layer.succeed(HttpClient.HttpClient, client),
    ),
  ),
);
const { test } = Test.make({ providers });

describe.sequential(
  "Flagship rule ownership",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:flagship", "local"] },
  () => {
    test.provider(
      "preserves omitted live rules during updates and clears an explicit empty array",
      (stack) =>
        Effect.gen(function* () {
          live = undefined;
          writes.length = 0;
          const program = (description?: string, rules?: FlagRule[]) =>
            Flag("Flag", {
              appId: "app",
              key: "flag",
              defaultVariation: "off",
              variations: { off: false, on: true },
              description,
              rules,
            });
          const initial = yield* stack.deploy(program());
          expect(initial.rules).toEqual([]);
          expect(writes).toHaveLength(1);
          expect(writes[0].rules).toEqual([]);

          live = {
            key: "flag",
            enabled: true,
            default_variation: "off",
            variations: { off: false, on: true },
            rules: externalRules,
          };
          writes.length = 0;
          const updated = yield* stack.deploy(program("changed"));
          expect(updated.rules).toEqual([{ priority: 1, conditions: [], serveVariation: "on" }]);
          expect(writes).toHaveLength(1);
          expect(writes[0].description).toBe("changed");
          expect(writes[0].rules).toEqual(externalRules);

          const cleared = yield* stack.deploy(program("changed", []));
          expect(cleared.rules).toEqual([]);
          expect(writes.at(-1)?.rules).toEqual([]);
          writes.length = 0;
          yield* stack.deploy(program("changed", []));
          expect(writes).toEqual([]);
          yield* stack.destroy();
        }),
    );
  },
);
