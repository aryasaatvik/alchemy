import { Gateway, GatewayResourceProvider } from "@alchemy.run/cloudflare/AI/Gateway";
import {
  CloudflareEnvironment,
  runtimeIdentity,
} from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const accountId = "0123456789abcdef0123456789abcdef";
const gatewayId = "byok-only-fixture";
const writes: { method: string; byokOnly: boolean }[] = [];
let live: boolean | undefined;

const gatewayResponse = () => ({
  id: gatewayId,
  cache_invalidate_on_update: false,
  cache_ttl: 0,
  collect_logs: true,
  created_at: "2026-01-01T00:00:00Z",
  modified_at: "2026-01-01T00:00:00Z",
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,
  byok_only: live,
});

// Exercise the real Distilled request/response codecs and provider lifecycle.
const client = HttpClient.make((request, url) =>
  Effect.sync(() => {
    if (!url.pathname.startsWith(`/client/v4/accounts/${accountId}/ai-gateway/gateways`)) {
      throw new Error(`Unscripted gateway request: ${request.method} ${url}`);
    }
    if (request.method === "DELETE") {
      const deleted = gatewayResponse();
      live = undefined;
      return HttpClientResponse.fromWeb(request, Response.json({ success: true, result: deleted }));
    }
    if (request.method === "GET" && live === undefined) {
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          { success: false, errors: [{ code: 7002, message: "Gateway not found" }] },
          { status: 404 },
        ),
      );
    }
    if (request.method === "POST" || request.method === "PUT") {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON gateway request");
      const body = Schema.decodeUnknownSync(Schema.Struct({ byok_only: Schema.Boolean }))(
        JSON.parse(new TextDecoder().decode(request.body.body)),
      );
      live = body.byok_only;
      writes.push({ method: request.method, byokOnly: live });
    } else if (request.method !== "GET") {
      throw new Error(`Unscripted gateway method: ${request.method}`);
    }
    return HttpClientResponse.fromWeb(
      request,
      Response.json({ success: true, result: gatewayResponse() }),
    );
  }),
);

const providers = GatewayResourceProvider().pipe(
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
  "Gateway byokOnly",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:ai", "local"] },
  () => {
    test.provider(
      "creates, observes drift, updates, and converges with owned credential policy",
      (stack) =>
        Effect.gen(function* () {
          live = undefined;
          writes.length = 0;
          const program = (byokOnly?: boolean) => Gateway("Gateway", { id: gatewayId, byokOnly });

          const initial = yield* stack.deploy(program());
          expect(initial.byokOnly).toBe(false);
          expect(writes).toEqual([
            { method: "POST", byokOnly: false },
            { method: "PUT", byokOnly: false },
          ]);

          const enabled = yield* stack.deploy(program(true));
          expect(enabled.byokOnly).toBe(true);
          expect(writes.at(-1)).toEqual({ method: "PUT", byokOnly: true });

          writes.length = 0;
          const noop = yield* stack.plan(program(true));
          expect(noop.resources.Gateway).toMatchObject({ action: "noop" });
          expect(writes).toEqual([]);

          // A policy change outside Alchemy must be observed before diffing.
          live = false;
          const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
          expect(drift.resources.Gateway).toMatchObject({
            action: "drifted",
            attr: { byokOnly: false },
          });
          expect(writes).toEqual([]);
          const repaired = yield* Drift.repair(stack).pipe(Effect.provide(stack.state));
          expect(repaired.resources.Gateway).toMatchObject({
            action: "repaired",
            attr: { byokOnly: true },
          });
          expect(writes.at(-1)).toEqual({ method: "PUT", byokOnly: true });
          const converged = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
          expect(converged.resources.Gateway?.action).toBe("unchanged");

          const disabled = yield* stack.deploy(program(false));
          expect(disabled.byokOnly).toBe(false);
          expect(writes.at(-1)).toEqual({ method: "PUT", byokOnly: false });

          yield* stack.deploy(program(true));
          const defaulted = yield* stack.deploy(program());
          expect(defaulted.byokOnly).toBe(false);
          expect(writes.at(-1)).toEqual({ method: "PUT", byokOnly: false });
          yield* stack.destroy();
        }),
    );
  },
);
