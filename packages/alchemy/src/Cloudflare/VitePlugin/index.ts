import cloudflareVitePlugin, {
  type CloudflareVitePluginOptions,
} from "@alchemy.run/cloudflare-runtime/vite";

const activeOptions = Symbol.for("alchemy.cloudflare.vite-plugin-options");

type GlobalWithVitePluginOptions = typeof globalThis & {
  [activeOptions]?: CloudflareVitePluginOptions;
};

const globals = globalThis as GlobalWithVitePluginOptions;

/** Whether the isolated Alchemy build child is carrying resource-aware options. */
export const hasActiveVitePluginOptions = (): boolean =>
  globals[activeOptions] !== undefined;

/**
 * The config-owned companion to `Cloudflare.Website.Vite`.
 *
 * Guard it with `ALCHEMY_CLOUDFLARE_VITE_INJECTED` in application Vite
 * configs. A standalone Vite invocation uses the supplied options. During an
 * Alchemy build, a framework-created nested Vite invocation uses the active
 * resource-aware options from the isolated build child instead.
 */
export const vitePlugin = (
  options: CloudflareVitePluginOptions = {},
): ReturnType<typeof cloudflareVitePlugin> =>
  cloudflareVitePlugin(globals[activeOptions] ?? options);

/** @internal Carries resource-aware options across nested Vite invocations. */
export const withVitePluginOptions = async <T>(
  options: CloudflareVitePluginOptions,
  action: () => Promise<T>,
): Promise<T> => {
  const previous = globals[activeOptions];
  globals[activeOptions] = options;
  try {
    return await action();
  } finally {
    if (previous === undefined) {
      delete globals[activeOptions];
    } else {
      globals[activeOptions] = previous;
    }
  }
};

export type { CloudflareVitePluginOptions };
