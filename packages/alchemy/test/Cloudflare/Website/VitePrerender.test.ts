import { viteBuild } from "@/Cloudflare/Workers/Sources/Vite.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

layer(NodeServices.layer)("Website.Vite prerender Worker", (it) => {
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
            {
              main: "server.mjs",
              compatibilityDate: "2026-09-20",
              compatibilityFlags: ["nodejs_compat"],
              prerenderWorker: {
                main: "capture.mjs",
                env: { TSS_PRERENDERING: "true" },
                assets: { runWorkerFirst: true },
              },
            },
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
