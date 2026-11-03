import type * as vite from "vite";
import type { BasePluginOptions } from "../rolldown/options.ts";

/** Reserved build-only environment, excluded from Alchemy's deploy bundle. */
export const PRERENDER_ENVIRONMENT = "alchemy_prerender";

export const prerender = (options: BasePluginOptions): vite.Plugin => ({
  name: "distilled-cloudflare:prerender",
  enforce: "pre",
  buildApp: {
    // Framework buildApp runs first; this precedes post-build prerender hooks.
    order: "post",
    async handler(builder) {
      if (!options.prerenderWorker) return;
      const environment = builder.environments[PRERENDER_ENVIRONMENT];
      if (!environment) throw new Error("Missing prerender Worker environment");
      if (!environment.isBuilt) await builder.build(environment);
    },
  },
});
