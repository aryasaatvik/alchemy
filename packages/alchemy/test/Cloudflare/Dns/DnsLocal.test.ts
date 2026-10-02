import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";
import {
  requireStandingZone,
  StandingZone,
  StandingZoneName,
} from "../StandingZone.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName = StandingZoneName;

// Deterministic record name — reused on every run (never derive from
// Date.now()/random), owns its own subdomain so it never collides with the
// managed-Record tests.
const RECORD_NAME = `alchemy-dnslocal.${zoneName}`;
const RECORD_TYPE = "TXT";
const RECORD_CONTENT = '"alchemy-dnslocal-seed"';

const resolveZoneId = requireStandingZone().pipe(Effect.map((zone) => zone.id));

// Delete every record matching (name, type) — used to clear leftovers from
// interrupted runs and to guarantee cleanup on finish.
const purgeRecords = (zoneId: string) =>
  dns.listRecords
    .items({
      zoneId,
      name: { exact: RECORD_NAME },
      type: RECORD_TYPE,
    })
    .pipe(
      Stream.filter((r) => r.name === RECORD_NAME && r.type === RECORD_TYPE),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.flatMap(
        Effect.forEach((r) =>
          dns
            .deleteRecord({ zoneId, dnsRecordId: r.id })
            .pipe(Effect.catch(() => Effect.void)),
        ),
      ),
    );

const findRecord = (zoneId: string) =>
  dns.listRecords
    .items({ zoneId, name: { exact: RECORD_NAME }, type: RECORD_TYPE })
    .pipe(
      Stream.filter((r) => r.name === RECORD_NAME && r.type === RECORD_TYPE),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)[0]),
    );

// Binding a DNS zone inside an Action via `ReadWriteDnsLocal` — the local
// (current-credentials) implementation of the `ReadWriteDns` binding. Exercises
// the write (create), read (get), list, and delete client surface plus the
// deferred zone-id accessor (`yield* zone.zoneId` resolved at apply time).
test.provider(
  "ReadWriteDnsLocal: create, read, list and delete a TXT record from an Action",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      // Clear leftovers from interrupted runs (Cloudflare allows duplicate
      // records for the same name/type).
      yield* purgeRecords(zoneId);

      const out = yield* stack
        .deploy(
          Effect.gen(function* () {
            // Adopt the standing test zone; it is retained on destroy.
            const zone = yield* StandingZone("DnsLocalZone");

            const Seed = Action(
              "Seed",
              Effect.gen(function* () {
                const dnsClient = yield* Cloudflare.DNS.ReadWriteDns(zone);
                // Accessor — resolved at apply time against the tracker.
                const zoneIdAccessor = yield* zone.zoneId;

                return Effect.fn(function* () {
                  const created = yield* dnsClient.createDnsRecord({
                    type: RECORD_TYPE,
                    name: RECORD_NAME,
                    content: RECORD_CONTENT,
                    ttl: 60,
                  });

                  const record = yield* dnsClient.getDnsRecord(created.id);

                  const listed = yield* dnsClient.listDnsRecords({
                    type: RECORD_TYPE,
                    name: { exact: RECORD_NAME },
                  });

                  yield* dnsClient.deleteDnsRecord(created.id);

                  return {
                    zoneId: yield* zoneIdAccessor,
                    recordId: created.id,
                    content: record.content,
                    listedContent: listed.result.find(
                      (r) => r.id === created.id,
                    )?.content,
                    listedCount: listed.result.length,
                  };
                });
              }).pipe(Effect.provide(Cloudflare.DNS.ReadWriteDnsLocal)),
            );

            return yield* Seed({});
          }),
        )
        .pipe(Effect.ensuring(purgeRecords(zoneId).pipe(Effect.ignore)));

      expect(out.zoneId).toEqual(zoneId);
      expect(out.recordId).toBeTruthy();
      expect(out.content).toEqual(RECORD_CONTENT);
      expect(out.listedContent).toEqual(RECORD_CONTENT);
      expect(out.listedCount).toBeGreaterThan(0);

      // The Action deleted the record — it is gone out-of-band.
      const gone = yield* findRecord(zoneId);
      expect(gone).toBeUndefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "provider:cloudflare:zone",
      "live",
    ],
    timeout: 120_000,
  },
);
