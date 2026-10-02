import { StandingZoneResource } from "../../StandingZone.ts";

/**
 * Bound in `DnsEffectWorker`'s init phase. `stack.ts` resolves the zone with
 * `requireStandingZone` before yielding the Worker, so this is never planned
 * against an account that lacks it.
 */
export const Zone = StandingZoneResource("alchemy-test-2.us");
