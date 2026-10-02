import { viteBuild } from "@/Cloudflare/Workers/Sources/Vite.ts";
import { resolveWorkerVitePluginOptions } from "@/Cloudflare/Workers/WorkerViteOptions.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

layer(NodeServices.layer)("Website.Vite prerender Worker", (it) => {
  it.effect("preserves ordinary build options without a prerender Worker", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const rootDir = path.resolve("ordinary-vite-app");
      const options = resolveWorkerVitePluginOptions(path, {
        compatibility: { date: "2026-09-20", flags: ["nodejs_compat"] },
        vite: {
          rootDir,
          main: "./server.mjs",
          viteEnvironments: { entry: "rsc", children: ["ssr"] },
        },
      });
      expect(options.main).toBe(path.join(rootDir, "server.mjs"));
      expect(options.compatibilityDate).toBe("2026-09-20");
      expect(options.compatibilityFlags).toContain("nodejs_compat");
      expect(options.viteEnvironments).toEqual({
        entry: "rsc",
        children: ["ssr"],
      });
      expect(options.prerenderWorker).toBeUndefined();
    }),
  );

  it.effect(
    "builds and previews with ASSETS without deploying capture modules",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(
            path.resolve(import.meta.dirname, "../../../.tmp"),
            { recursive: true },
          );
          const rootDir = yield* fs.makeTempDirectoryScoped({
            directory: path.resolve(import.meta.dirname, "../../../.tmp"),
            prefix: "vite-prerender-",
          });
          yield* fs.copy(
            path.join(import.meta.dirname, "prerender-fixture"),
            rootDir,
          );
          const result = yield* viteBuild(
            rootDir,
            {},
            resolveWorkerVitePluginOptions(path, {
              compatibility: {
                date: "2026-09-20",
                flags: ["nodejs_compat"],
              },
              vite: {
                rootDir,
                main: "server.mjs",
                prerenderWorker: {
                  main: "capture.mjs",
                  env: { TSS_PRERENDERING: "true" },
                  assets: { runWorkerFirst: true },
                },
              },
            }),
            "Website.Vite.Prerender",
          );
          expect(
            yield* fs.readFileString(
              path.join(result.clientDirectory!, "capture.md"),
            ),
          ).toBe("# Build-only capture\nwebsite assets\n");
          expect(
            yield* fs.exists(
              path.join(rootDir, "dist/alchemy_prerender/capture.js"),
            ),
          ).toBe(true);
          const bundle = yield* result.serverBundle;
          expect(bundle).toBeDefined();
          expect(
            bundle!.files.every(
              (file) => !file.path.includes("alchemy_prerender"),
            ),
          ).toBe(true);
          expect(
            bundle!.files.map((file) => file.content).join("\n"),
          ).not.toContain("Build-only capture");
        }),
      ),
    { timeout: 120_000 },
  );
});
