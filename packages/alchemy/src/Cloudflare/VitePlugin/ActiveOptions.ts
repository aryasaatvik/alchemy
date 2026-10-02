import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";

/**
 * The resource-aware Cloudflare Vite plugin options of the Alchemy build
 * running in this process, carried on `globalThis` under a registered symbol
 * so every copy of this module sees them: the build child and the app's Vite
 * config can load Alchemy from different paths (`src` vs `lib`).
 */
const activeOptions = Symbol.for("alchemy.cloudflare.vite-plugin-options");

type GlobalWithVitePluginOptions = typeof globalThis & {
  [activeOptions]?: CloudflareVitePluginOptions;
};

const globals = globalThis as GlobalWithVitePluginOptions;

export const getActiveVitePluginOptions = ():
  | CloudflareVitePluginOptions
  | undefined => globals[activeOptions];

/**
 * Publish `options` as the active plugin options and return a function that
 * restores the previous value.
 */
export const activateVitePluginOptions = (
  options: CloudflareVitePluginOptions,
): (() => void) => {
  const previous = globals[activeOptions];
  globals[activeOptions] = options;
  return () => {
    if (previous === undefined) {
      delete globals[activeOptions];
    } else {
      globals[activeOptions] = previous;
    }
  };
};
