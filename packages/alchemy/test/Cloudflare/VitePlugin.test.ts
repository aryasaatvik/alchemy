import { runViteBuildChild } from "@/Cloudflare/Workers/ViteChild.ts";
import {
  hasActiveVitePluginOptions,
  vitePlugin,
} from "@/Cloudflare/VitePlugin/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

interface ProbeResult {
  /** One entry per evaluation of the fixture's config file. */
  readonly loads: ReadonlyArray<{ injected: boolean; active: boolean }>;
  /** Alchemy plugin names in the config resolved from inside `buildApp`. */
  readonly nestedPlugins: ReadonlyArray<string>;
  /** The Worker entry the nested config's Alchemy plugin would build. */
  readonly nestedInput: Record<string, string> | undefined;
}

// Emulates TanStack Start's prerender: while the build runs, load the config
// file again (TanStack starts `vite.preview({ configFile })`) and record what
// that nested config resolves to.
const probeConfig = `import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import {
  hasActiveVitePluginOptions,
  vitePlugin,
} from "alchemy/Cloudflare/VitePlugin";

const loads = (globalThis.__alchemyNestedViteProbe ??= []);
const injected = process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1";
const active = hasActiveVitePluginOptions();
loads.push({ injected, active });

export default {
  plugins: [
    ...(injected ? [] : active ? [vitePlugin()] : []),
    {
      name: "nested-config-probe",
      buildApp: {
        order: "post",
        async handler() {
          const configFile = fileURLToPath(import.meta.url);
          const nested = await resolveConfig({ configFile }, "build");
          const options = nested.plugins.find(
            (plugin) => plugin.name === "distilled-cloudflare:options",
          );
          writeFileSync(
            new URL("./probe.json", import.meta.url),
            JSON.stringify({
              loads,
              nestedPlugins: nested.plugins
                .map((plugin) => plugin.name)
                .filter((name) => name === "vite-plugin-cloudflare:alchemy"),
              nestedInput: options?.api?.input(),
            }),
          );
        },
      },
    },
  ],
};
`;

layer(NodeServices.layer)("Cloudflare VitePlugin", (it) => {
  it.effect(
    "gives a config loaded again during an Alchemy build the build's plugin options",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          // Under the alchemy package so the fixture config resolves `vite`
          // and `alchemy/Cloudflare/VitePlugin` the way an app does (the
          // workspace links `alchemy` into the root node_modules).
          const tempRoot = path.resolve(import.meta.dirname, "../../.tmp");
          yield* fs.makeDirectory(tempRoot, { recursive: true });
          const rootDir = yield* fs.makeTempDirectoryScoped({
            directory: tempRoot,
            prefix: "alchemy-vite-nested-",
          });
          const main = path.join(rootDir, "worker.js");
          yield* fs.writeFileString(
            main,
            'export default { fetch: () => new Response("ok") };\n',
          );
          yield* fs.writeFileString(
            path.join(rootDir, "vite.config.mjs"),
            probeConfig,
          );

          yield* runViteBuildChild(
            {
              rootDir,
              env: {},
              main,
              compatibilityDate: "2026-01-01",
              compatibilityFlags: undefined,
              viteEnvironments: undefined,
            },
            () => Effect.void,
          );

          const probe = JSON.parse(
            yield* fs.readFileString(path.join(rootDir, "probe.json")),
          ) as ProbeResult;
          // The build's own config loads (Vite resolves it once more per
          // environment) see Alchemy's injected plugin.
          const nestedLoad = probe.loads.at(-1);
          const buildLoads = probe.loads.slice(0, -1);
          expect(buildLoads.length).toBeGreaterThan(0);
          for (const load of buildLoads) {
            expect(load).toEqual({ injected: true, active: true });
          }
          // The nested load is not injected, but the build's options are
          // active, so the config adds `vitePlugin()`.
          expect(nestedLoad).toEqual({ injected: false, active: true });
          expect(probe.nestedPlugins).toEqual([
            "vite-plugin-cloudflare:alchemy",
          ]);
          expect(Object.values(probe.nestedInput ?? {})).toEqual([main]);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect("uses the given options outside an Alchemy build", () =>
    Effect.sync(() => {
      expect(hasActiveVitePluginOptions()).toBe(false);
      const plugins = (vitePlugin() as ReadonlyArray<{ name: string }>).map(
        (plugin) => plugin.name,
      );
      expect(plugins).toContain("vite-plugin-cloudflare:alchemy");
    }),
  );
});
