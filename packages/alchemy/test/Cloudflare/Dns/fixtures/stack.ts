import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import { requireStandingZone } from "../../StandingZone.ts";
import DnsEffectWorker from "./effect.ts";

export default Alchemy.Stack(
  "DnsTestStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // Resolve the standing zone before the Worker declares it: fails the
    // plan when the account lacks it instead of creating it.
    yield* requireStandingZone().pipe(Effect.orDie);
    const effectWorker = yield* DnsEffectWorker;
    return {
      effectUrl: effectWorker.url.as<string>(),
    };
  }),
);
