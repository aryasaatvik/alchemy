import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import {
  CloudflareEnvironment,
  runtimeIdentity,
} from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  requireStandingZone,
  StandingZone,
  StandingZoneMissing,
} from "./StandingZone.ts";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const STANDING_ZONE_ID = "fedcba9876543210fedcba9876543210";
const ZONE_NAME = "alchemy-standing-zone.test";

/**
 * Stand-in for the Cloudflare zones API. Records every request as
 * `METHOD /path?query`; answers `GET /zones?name=…` and `GET /zones/{id}` from
 * `zonesOnAccount` and dies on anything else (a `POST /zones` would be
 * `createZone`). The tests in this file run sequentially and reset both at the
 * start of each test.
 */
const api = {
  requests: [] as string[],
  zonesOnAccount: [] as { id: string; name: string }[],
  reset(zonesOnAccount: { id: string; name: string }[]) {
    api.requests = [];
    api.zonesOnAccount = zonesOnAccount;
  },
};

const zoneObject = (zone: { id: string; name: string }) => ({
  ...zone,
  account: { id: ACCOUNT_ID, name: "test" },
  status: "active",
  type: "full",
  paused: false,
  name_servers: ["a.ns.cloudflare.test", "b.ns.cloudflare.test"],
  original_name_servers: [],
  created_on: "2026-01-01T00:00:00Z",
  modified_on: "2026-01-01T00:00:00Z",
  activated_on: "2026-01-01T00:00:00Z",
  development_mode: 0,
  meta: {},
  owner: {},
  permissions: [],
});

const zonesApi = HttpClient.make((request, url) =>
  Effect.gen(function* () {
    api.requests.push(`${request.method} ${url.pathname}${url.search}`);
    const byId = api.zonesOnAccount.find((zone) =>
      url.pathname.endsWith(`/zones/${zone.id}`),
    );
    if (request.method === "GET" && byId) {
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: zoneObject(byId),
        }),
      );
    }
    const name = url.searchParams.get("name");
    if (request.method !== "GET" || !url.pathname.endsWith("/zones") || !name) {
      return yield* Effect.die(
        `unexpected zones API request: ${request.method} ${url}`,
      );
    }
    const match = api.zonesOnAccount.find((zone) => zone.name === name);
    return HttpClientResponse.fromWeb(
      request,
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: match ? [zoneObject(match)] : [],
      }),
    );
  }),
);

/**
 * The real Zone provider over a stubbed account: no profile, no credential
 * resolution, and every API call lands on {@link zonesApi}.
 */
const providers = Cloudflare.Zone.ZoneProvider().pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(
        CloudflareEnvironment,
        Effect.succeed(runtimeIdentity(ACCOUNT_ID)),
      ),
      Layer.succeed(
        Credentials,
        Effect.succeed(
          apiTokenCredentials({
            apiToken: "test-token",
            apiBaseUrl: "https://api.cloudflare.test/client/v4",
          }),
        ),
      ),
      Layer.succeed(HttpClient.HttpClient, zonesApi),
    ),
  ),
);

const { test } = Test.make({ providers });

const isCreate = (request: string) => request.startsWith("POST ");

describe.sequential(
  "StandingZone",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:zone", "local"],
  },
  () => {
    test.provider("requireStandingZone resolves an existing zone by name", () =>
      Effect.gen(function* () {
        api.reset([{ id: STANDING_ZONE_ID, name: ZONE_NAME }]);
        const zone = yield* requireStandingZone(ZONE_NAME);
        expect(zone.id).toBe(STANDING_ZONE_ID);
        expect(api.requests).toHaveLength(1);
        expect(api.requests[0]).toMatch(/^GET \/client\/v4\/zones\?/);
      }),
    );

    test.provider(
      "requireStandingZone fails with StandingZoneMissing when no zone matches",
      () =>
        Effect.gen(function* () {
          api.reset([{ id: STANDING_ZONE_ID, name: "other.test" }]);
          const error = yield* requireStandingZone(ZONE_NAME).pipe(Effect.flip);
          expect(error).toBeInstanceOf(StandingZoneMissing);
          if (error instanceof StandingZoneMissing) {
            expect(error.name).toBe(ZONE_NAME);
            expect(error.accountId).toBe(ACCOUNT_ID);
          }
          expect(api.requests).toHaveLength(1);
          expect(api.requests.some(isCreate)).toBe(false);
        }),
    );

    // Control: this is the declaration shape the guard replaces. With the
    // zone missing, the engine plans a `create` — the leak.
    test.provider(
      "an unguarded adopted Zone plans a create when the zone is missing",
      (stack) =>
        Effect.gen(function* () {
          api.reset([]);
          const plan = yield* stack.plan(
            Cloudflare.Zone.Zone("Standing", { name: ZONE_NAME }).pipe(
              adopt(true),
            ),
          );
          expect(plan.resources.Standing).toMatchObject({ action: "create" });
        }),
    );

    test.provider(
      "StandingZone dies with StandingZoneMissing during plan and never calls createZone",
      (stack) =>
        Effect.gen(function* () {
          api.reset([]);
          const exit = yield* stack
            .deploy(StandingZone("Standing", ZONE_NAME))
            .pipe(Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const defects = exit.cause.reasons
              .filter(Cause.isDieReason)
              .map((reason) => reason.defect);
            expect(
              defects.some((defect) => defect instanceof StandingZoneMissing),
            ).toBe(true);
          }
          // Only the guard's name lookup reached the API: the Zone provider
          // never observed, let alone created, the zone.
          expect(api.requests).toHaveLength(1);
          expect(api.requests[0]).toMatch(/^GET \/client\/v4\/zones\?/);
          expect(api.requests.some(isCreate)).toBe(false);
        }),
    );

    test.provider(
      "StandingZone plans an adoption of an existing zone, never a create",
      (stack) =>
        Effect.gen(function* () {
          api.reset([{ id: STANDING_ZONE_ID, name: ZONE_NAME }]);
          const plan = yield* stack.plan(StandingZone("Standing", ZONE_NAME));
          expect(plan.resources.Standing).toMatchObject({ action: "adopted" });
          expect(api.requests.some(isCreate)).toBe(false);
        }),
    );
  },
);
