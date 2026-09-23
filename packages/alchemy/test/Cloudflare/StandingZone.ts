import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import { retain } from "@/RemovalPolicy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Name of the standing Cloudflare test zone: a long-lived, shared, active zone
 * that live suites point DNS records, Access applications, rulesets and ACME
 * challenges at. It exists in the testing account and is never created or
 * deleted by a test. Override with `CLOUDFLARE_TEST_DNS_ZONE_NAME`.
 *
 * Read through `globalThis.process` because Worker fixtures import this module
 * into their bundle, and workerd has no `process` global without
 * `nodejs_compat`.
 */
export const StandingZoneName =
  globalThis.process?.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

/**
 * The standing test zone is not in the account the suite runs against. The
 * suite never creates it — point `CLOUDFLARE_TEST_DNS_ZONE_NAME` at an active
 * zone in the account, or run against the testing account.
 */
export class StandingZoneMissing extends Data.TaggedError(
  "StandingZoneMissing",
)<{
  readonly name: string;
  readonly accountId: string;
  readonly message: string;
}> {}

/**
 * Resolve the standing zone by name, failing with {@link StandingZoneMissing}
 * when the account has no such zone. A read-only lookup (`GET /zones`); it
 * never creates anything.
 */
export const requireStandingZone = (name: string = StandingZoneName) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zone = yield* findZoneByName({ accountId, name });
    if (zone === undefined) {
      return yield* new StandingZoneMissing({
        name,
        accountId,
        message:
          `Standing test zone "${name}" not found in Cloudflare account ` +
          `${accountId}. Tests never create it: set ` +
          `CLOUDFLARE_TEST_DNS_ZONE_NAME to an active zone in this account.`,
      });
    }
    return zone;
  });

/**
 * The standing zone's resource declaration WITHOUT the existence check, for
 * Worker fixtures that bind it in their init phase (e.g.
 * `Cloudflare.DNS.ReadWriteDns(zone)`), where the lookup's credentials are not
 * available.
 *
 * The Stack that deploys such a Worker MUST `yield* requireStandingZone()`
 * (with `Effect.orDie`) before it yields the Worker, so a missing zone fails
 * the plan before this declaration is ever evaluated — see
 * `Dns/fixtures/stack.ts`. Everywhere else, use {@link StandingZone}.
 */
export const StandingZoneResource = (
  id: string,
  name: string = StandingZoneName,
) => Cloudflare.Zone.Zone(id, { name }).pipe(adopt(true), retain());

/**
 * Declare the standing zone as an adopted {@link Cloudflare.Zone.Zone} resource
 * for bindings and props that need the resource itself (e.g.
 * `Cloudflare.Ruleset.Ruleset({ zone })`, an `Action` binding
 * `Cloudflare.DNS.ReadWriteDnsLocal`).
 *
 * The zone is resolved by name before the resource is declared, so when it is
 * missing the stack program dies with {@link StandingZoneMissing} during plan —
 * before any resource in the stack is applied, and without ever reaching the
 * Zone provider's create path. `adopt(true)` then takes over the existing zone
 * and `retain()` keeps teardown from deleting it.
 *
 * `adopt(true)` alone would *create* a missing zone, which then outlives the
 * test because zones retain on removal. An engine-level "adopt existing only,
 * never create" mode (e.g. an `AdoptPolicy` variant that fails when `read`
 * finds nothing) would make this a resource-level guarantee and replace the
 * pre-declaration lookup.
 *
 * Worker init phases cannot require Cloudflare credentials, so the type
 * checker rejects this inside one; use {@link StandingZoneResource} there.
 */
export const StandingZone = (id: string, name: string = StandingZoneName) =>
  requireStandingZone(name).pipe(
    Effect.orDie,
    Effect.andThen(StandingZoneResource(id, name)),
  );
