// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { loadInternalWorker } from "../../core/internal/internal-worker.ts";
import * as Assets from "../../core/bindings/assets/Assets.ts";
import { DEFAULT_COMPATIBILITY_DATE } from "../../core/internal/constants.ts";
import * as Loopback from "../../core/globals/Loopback.ts";
import { PluginContext } from "../../core/PluginContext.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import mime from "mime";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type * as vite from "vite";
const AssetsWorker = {
  worker: () =>
    loadInternalWorker("#cloudflare-runtime-vite-worker/assets/assets.worker"),
};
const RouterWorker = {
  worker: () =>
    loadInternalWorker("#cloudflare-runtime-vite-worker/assets/router.worker"),
};
/**
 * Marker prefix used by the vite-aware asset worker to indicate that an
 * HTML path lives inside Vite's `publicDir` (and so should be served
 * verbatim, without running through `transformIndexHtml`).
 */
const PUBLIC_DIR_PREFIX = "__VITE_PUBLIC_DIR__";

/**
 * Asset plugin layer wired to a Vite dev server.
 *
 * Unlike {@link Assets.AssetsLive}, this implementation does not build a
 * disk-backed asset manifest or KV namespace at all: the vite-aware asset
 * worker overrides `unstable_exists` / `unstable_getByETag` to delegate
 * every HTML lookup back to Vite via Loopback bindings, so HMR,
 * `transformIndexHtml`, virtual routes, and files in `publicDir` all
 * resolve through the dev server instead of through a static snapshot.
 *
 * Mirrors the dev-mode asset wiring in
 * `upstream/workers-sdk/packages/vite-plugin-cloudflare/src/miniflare-options.ts`.
 */
export const ViteAssetsLive = (viteDevServer: vite.ViteDevServer) =>
  Layer.effect(
    Assets.Assets,
    Effect.gen(function* () {
      const loopback = yield* Loopback.Loopback;

      if (Effect.isEffect(loopback)) {
        return yield* Effect.die("Expected loopback to be initialized");
      }

      return Assets.Assets.of(
        Effect.gen(function* () {
          const { worker } = yield* PluginContext;
          const { assetsConfig, routerConfig } =
            yield* Assets.buildAssetConfigs(worker);

          const prefix = `vite-assets:${encodeURIComponent(worker.name)}`;
          const htmlExistsService = yield* loopback.api.route(
            `${prefix}:html-exists`,
            viteHtmlExistsHandler(viteDevServer),
          );
          const fetchHtmlService = yield* loopback.api.route(
            `${prefix}:fetch-html`,
            viteFetchHtmlHandler(viteDevServer),
          );
          const [assetsWorker, routerWorker] = yield* Effect.forEach(
            [AssetsWorker, RouterWorker],
            (worker) =>
              Effect.map(Effect.promise(worker.worker), ({ modules }) =>
                modulesToWorkerd(modules),
              ),
            { concurrency: "unbounded" },
          );

          return {
            services: [
              {
                name: "assets:worker",
                worker: {
                  compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                  // Node.js compatibility is supplied by the 2026-08-31
                  // internal compatibility date.
                  bindings: [
                    {
                      name: "CONFIG",
                      json: JSON.stringify(assetsConfig),
                    },
                    {
                      name: "__VITE_HEADERS__",
                      json: JSON.stringify(
                        viteDevServer.config.server.headers ?? {},
                      ),
                    },
                    {
                      name: "__VITE_HTML_EXISTS__",
                      service: htmlExistsService,
                    },
                    {
                      name: "__VITE_FETCH_HTML__",
                      service: fetchHtmlService,
                    },
                  ],
                  modules: assetsWorker,
                },
              },
            ],
            middlewares: [
              {
                name: "assets:router",
                worker: {
                  compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                  // The date supplies nodejs_compat; this worker deliberately
                  // retains only its v2 opt-out.
                  compatibilityFlags: ["no_nodejs_compat_v2"],
                  bindings: [
                    {
                      name: "ASSET_WORKER",
                      service: { name: "assets:worker" },
                    },
                    {
                      name: "CONFIG",
                      json: JSON.stringify(routerConfig),
                    },
                  ],
                  modules: routerWorker,
                },
                upstreamBindingName: "USER_WORKER",
                order: -1,
              },
            ],
            api: { isConfigured: true },
          };
        }),
      );
    }),
  );

/**
 * Resolves a request pathname to a file inside `dir`, or `null` when the
 * decoded path escapes `dir` or is not a regular file.
 */
const resolveFileInDir = async (dir: string, pathname: string) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const base = NodePath.resolve(dir);
  const resolved = NodePath.resolve(base, `.${decoded}`);
  if (!resolved.startsWith(withTrailingSlash(base))) {
    return null;
  }
  try {
    return (await NodeFs.stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
};

/**
 * Returns the resolved on-disk path for a pathname (or `null`). HTML is
 * looked up under the root and `publicDir`; every other file is served only
 * from `publicDir`. Files under `publicDir` are prefixed with
 * `PUBLIC_DIR_PREFIX` so the companion handler serves them verbatim, without
 * running `transformIndexHtml`.
 */
const viteHtmlExistsHandler =
  (viteDevServer: vite.ViteDevServer) =>
  async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const { root, publicDir } = viteDevServer.config;

    if (!pathname.endsWith(".html")) {
      // `publicDir` is an empty string when Vite's public directory is disabled.
      const publicFile = publicDir
        ? await resolveFileInDir(publicDir, pathname)
        : null;
      return json(publicFile ? `${PUBLIC_DIR_PREFIX}${pathname}` : null);
    }
    const publicDirInRoot = publicDir.startsWith(withTrailingSlash(root));
    const publicPath = withTrailingSlash(publicDir.slice(root.length));

    // Files served from the public dir are addressed from the root path.
    if (publicDirInRoot && pathname.startsWith(publicPath)) {
      return json(null);
    }

    const publicDirFilePath = `${publicDir}${pathname}`;
    const rootDirFilePath = `${root}${pathname}`;

    for (const resolved of [publicDirFilePath, rootDirFilePath]) {
      try {
        const stats = await NodeFs.stat(resolved);
        if (stats.isFile()) {
          return json(
            resolved === publicDirFilePath
              ? `${PUBLIC_DIR_PREFIX}${pathname}`
              : pathname,
          );
        }
      } catch {
        // continue
      }
    }
    return json(null);
  };

/**
 * Returns the body for a path previously resolved by
 * {@link viteHtmlExistsHandler}. Non-public HTML is run through
 * `viteDevServer.transformIndexHtml` so that HMR and plugin transforms
 * apply; `publicDir` files are returned as raw bytes with their own
 * content type.
 */
const viteFetchHtmlHandler =
  (viteDevServer: vite.ViteDevServer) =>
  async (req: IncomingMessage, res: ServerResponse) => {
    // The asset worker passes the eTag as a URL path, which adds a leading `/`.
    const pathname = new URL(
      req.url ?? "/",
      "http://localhost",
    ).pathname.replace(/^\//, "");
    const { root, publicDir } = viteDevServer.config;
    const isInPublicDir = pathname.startsWith(PUBLIC_DIR_PREFIX);

    try {
      if (isInPublicDir) {
        const resolved = await resolveFileInDir(
          publicDir,
          pathname.slice(PUBLIC_DIR_PREFIX.length),
        );
        if (!resolved) {
          throw new Error("Not a file in publicDir");
        }
        const body = await NodeFs.readFile(resolved);
        res.writeHead(200, {
          "content-type": mime.getType(resolved) ?? "application/octet-stream",
        });
        res.end(body);
        return;
      }
      const resolved = `${root}/${pathname}`;
      const html = await viteDevServer.transformIndexHtml(
        resolved,
        await NodeFs.readFile(resolved, "utf-8"),
      );
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`Unexpected error. Failed to load "${pathname}".`);
    }
  };

const withTrailingSlash = (s: string) => (s.endsWith("/") ? s : `${s}/`);

const modulesToWorkerd = (modules: Record<string, string>) =>
  Object.entries(modules).map(([name, esModule]) => ({
    name,
    esModule,
  }));
