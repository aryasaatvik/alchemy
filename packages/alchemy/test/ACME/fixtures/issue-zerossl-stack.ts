import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { requireStandingZone } from "../../Cloudflare/StandingZone.ts";
import AcmeIssueZeroSslWorker from "./issue-worker-zerossl.ts";

export default Alchemy.Stack(
  "AcmeIssueZeroSslStack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), ACME.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // Resolve the standing zone before the Worker declares it: fails the
    // plan when the account lacks it instead of creating it.
    yield* requireStandingZone().pipe(Effect.orDie);
    const worker = yield* AcmeIssueZeroSslWorker;
    return { url: worker.url.as<string>() };
  }),
);
