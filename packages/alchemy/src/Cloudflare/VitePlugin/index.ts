import cloudflareVitePlugin, {
  type CloudflareVitePluginOptions,
} from "@alchemy.run/cloudflare-runtime/vite";
import { getActiveVitePluginOptions } from "./ActiveOptions.ts";

/**
 * Whether this process is running an Alchemy Vite build, i.e. whether
 * {@link vitePlugin} will use the build's resource-aware options.
 */
export const hasActiveVitePluginOptions = (): boolean =>
  getActiveVitePluginOptions() !== undefined;

/**
 * Alchemy's Cloudflare Vite plugin for a Vite config that frameworks load
 * again during an Alchemy build.
 *
 * Alchemy injects its plugin into the build's top-level Vite config only.
 * Some frameworks start a nested Vite server from the config file during the
 * build — e.g. TanStack Start's prerender runs
 * `vite.preview({ configFile })` — and that nested config does not include
 * the injected plugin. `ALCHEMY_CLOUDFLARE_VITE_INJECTED` is `"1"` only
 * while the top-level config loads, so a nested load can add this plugin: it
 * receives the build's resource-aware options (entry, compatibility, Vite
 * environments), so the nested preview serves the built Worker in workerd.
 * Outside an Alchemy build it uses `options`.
 *
 * ```ts
 * // vite.config.ts
 * import { cloudflare } from "@cloudflare/vite-plugin";
 * import {
 *   hasActiveVitePluginOptions,
 *   vitePlugin,
 * } from "alchemy/Cloudflare/VitePlugin";
 *
 * const cloudflarePlugins =
 *   process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
 *     ? [] // top-level Alchemy build or dev: Alchemy injects its plugin
 *     : hasActiveVitePluginOptions()
 *       ? [vitePlugin()] // nested Vite server inside an Alchemy build
 *       : [cloudflare({ viteEnvironment: { name: "ssr" } })]; // plain `vite`
 * ```
 */
export const vitePlugin = (
  options: CloudflareVitePluginOptions = {},
): ReturnType<typeof cloudflareVitePlugin> =>
  cloudflareVitePlugin(getActiveVitePluginOptions() ?? options);

export type { CloudflareVitePluginOptions };
