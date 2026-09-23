import {
  cachedResolveZoneId,
  isId,
  resolveZoneId,
  zoneNameCandidates,
} from "@/Cloudflare/Zone/lookup.ts";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

describe(
  "Cloudflare zone lookup",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:zone", "local"],
  },
  () => {
    const withoutCredentials = <A, E>(
      effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
    ) =>
      effect.pipe(
        Effect.provideService(
          Credentials,
          Effect.die("explicit zone IDs must not resolve credentials"),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die("explicit zone IDs must not list zones"),
          ),
        ),
        Effect.runSync,
      );

    test("zoneNameCandidates walks hostname labels longest-first", () => {
      expect(zoneNameCandidates("app.example.com")).toEqual([
        "app.example.com",
        "example.com",
      ]);
      expect(zoneNameCandidates("a.b.c.example.com")).toEqual([
        "a.b.c.example.com",
        "b.c.example.com",
        "c.example.com",
        "example.com",
      ]);
      expect(zoneNameCandidates("example.com")).toEqual(["example.com"]);
    });

    test("resolveZoneId returns an explicit zone id without listing zones", () => {
      const zoneId = "0123456789abcdef0123456789abcdef";
      expect(isId(zoneId)).toBe(true);
      expect(
        withoutCredentials(
          resolveZoneId({
            accountId: "account",
            zone: zoneId,
            hostname: "app.example.com",
          }),
        ),
      ).toEqual(zoneId);
      expect(
        withoutCredentials(
          resolveZoneId({
            accountId: "account",
            zone: { zoneId, name: "example.com" },
            hostname: "app.example.com",
          }),
        ),
      ).toEqual(zoneId);
    });

    const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    const EXAMPLE_ZONE_ID = "fedcba9876543210fedcba9876543210";

    /**
     * Stands in for `GET /zones?account.id=…&name=…&per_page=1`, the only
     * request `findZoneByName` makes, and records each looked-up name. Every
     * response waits a few milliseconds so concurrent callers overlap.
     */
    const withZonesApi = <A, E>(
      zonesOnAccount: { id: string; name: string }[],
      body: (
        queried: string[],
      ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
    ) =>
      Effect.suspend(() => {
        const queried: string[] = [];
        const client = HttpClient.make((request, url) =>
          Effect.gen(function* () {
            const name = url.searchParams.get("name");
            if (!name) {
              return yield* Effect.die(`unfiltered zone listing: ${url}`);
            }
            queried.push(name);
            yield* Effect.sleep("10 millis");
            const match = zonesOnAccount.find((zone) => zone.name === name);
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                success: true,
                errors: [],
                messages: [],
                result: match
                  ? [{ ...match, account: { id: ACCOUNT_ID } }]
                  : [],
              }),
            );
          }),
        );
        return body(queried).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(
            Credentials,
            Effect.succeed(
              apiTokenCredentials({
                apiToken: "test-token",
                apiBaseUrl: "https://api.cloudflare.test/client/v4",
              }),
            ),
          ),
        );
      });

    test.live("concurrent lookups of one hostname share a single request", () =>
      withZonesApi([{ id: EXAMPLE_ZONE_ID, name: "example.com" }], (queried) =>
        Effect.gen(function* () {
          const resolveZone = yield* cachedResolveZoneId();
          const resolved = yield* Effect.all(
            Array.from({ length: 8 }, () =>
              resolveZone({
                accountId: ACCOUNT_ID,
                zone: undefined,
                hostname: "example.com",
              }),
            ),
            { concurrency: "unbounded" },
          );
          expect(resolved).toEqual(Array(8).fill(EXAMPLE_ZONE_ID));
          expect(queried).toEqual(["example.com"]);
        }),
      ),
    );

    test.live("an unmatched hostname fails with a typed ZoneNotFound", () =>
      withZonesApi([{ id: EXAMPLE_ZONE_ID, name: "other.com" }], (queried) =>
        Effect.gen(function* () {
          const error = yield* resolveZoneId({
            accountId: ACCOUNT_ID,
            zone: undefined,
            hostname: "api.example.com",
          }).pipe(Effect.flip);
          expect(error._tag).toBe("ZoneNotFound");
          if (error._tag === "ZoneNotFound") {
            expect(error.name).toBe("api.example.com");
          }
          expect(queried).toEqual(["api.example.com", "example.com"]);
        }),
      ),
    );
  },
);
