import { viteBuild } from "@alchemy.run/cloudflare/Workers/Sources/Vite";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

layer(NodeServices.layer)("Website.Vite prerender Worker", (it) => {
  for (const configuredBy of ["Alchemy", "vite.config"] as const) {
    it.effect(
      `builds a prerender Worker configured by ${configuredBy} without deploying its modules`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            yield* fs.makeDirectory(path.resolve(import.meta.dirname, "../../../.tmp"), {
              recursive: true,
            });
            const rootDir = yield* fs.makeTempDirectoryScoped({
              directory: path.resolve(import.meta.dirname, "../../../.tmp"),
              prefix: "vite-prerender-",
            });
            yield* fs.copy(path.join(import.meta.dirname, "prerender-fixture"), rootDir);
            const prerenderWorker = {
              main: "capture.mjs",
              env: { TSS_PRERENDERING: "true" },
              assets: { runWorkerFirst: true },
            };
            const main = path.join(rootDir, "server.mjs");
            if (configuredBy === "vite.config") {
              // The app's plugin is present even when Alchemy injects its own.
              // Build the additional environment without starting a preview.
              yield* fs.writeFileString(
                path.join(rootDir, "vite.config.mjs"),
                `import cloudflare from "@alchemy.run/cloudflare-runtime/vite";
export default { plugins: [cloudflare(${JSON.stringify({ main, prerenderWorker })})] };
`,
              );
            }
            const result = yield* viteBuild(
              rootDir,
              {},
              {
                main,
                prerenderWorker: configuredBy === "Alchemy" ? prerenderWorker : undefined,
                compatibilityDate: "2026-09-20",
                compatibilityFlags: ["nodejs_compat"],
              },
              "Website.Vite.Prerender",
            );
            if (configuredBy === "Alchemy") {
              expect(
                yield* fs.readFileString(path.join(result.clientDirectory!, "capture.md")),
              ).toBe("# Build-only capture\nwebsite assets\n");
            }
            expect(yield* fs.exists(path.join(rootDir, "dist/alchemy_prerender/capture.js"))).toBe(
              true,
            );
            const bundle = yield* result.serverBundle;
            expect(bundle).toBeDefined();
            expect(bundle!.files.every((file) => !file.path.includes("alchemy_prerender"))).toBe(
              true,
            );
            expect(bundle!.files.map((file) => file.content).join("\n")).not.toContain(
              "Build-only capture",
            );
          }),
        ),
      { timeout: 120_000 },
    );
  }
});
