import type * as Path from "effect/Path";

/**
 * Resolve `vite.main` for the Cloudflare Vite plugin.
 *
 * Explicitly relative (`./`, `../`) entries are absolutized against the Vite
 * root, so a deploy driven from another directory still finds them (#796).
 * Anything else is passed through verbatim: a module id such as
 * `virtual:flue/worker` or a package specifier must reach Vite's plugin
 * pipeline unchanged, and a bare root-relative path (`src/worker.ts`) is
 * resolved against the Vite root by the plugin's own `resolveInputPath`.
 */
export const resolveViteMain = (
  path: Pick<Path.Path, "isAbsolute" | "resolve">,
  root: string,
  main: string | undefined,
): string | undefined => {
  if (main === undefined || path.isAbsolute(main)) return main;
  return main.startsWith("./") || main.startsWith("../")
    ? path.resolve(root, main)
    : main;
};
