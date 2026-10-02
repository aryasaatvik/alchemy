import { runViteBuildChild } from "@/Cloudflare/Workers/ViteChild.ts";
import { resolveViteMain } from "@/Cloudflare/Workers/ViteMain.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const root = "/repo/apps/agents";

const MARKER = "vite-main-virtual-entry-marker";

// A plugin that owns the Worker entry as a virtual module, the way
// `@flue/vite` provides `virtual:flue/worker`.
const virtualEntryConfig = `export default {
  plugins: [
    {
      name: "virtual-worker-entry",
      resolveId(id) {
        if (id === "virtual:test/worker") return "\\0virtual:test/worker";
      },
      load(id) {
        if (id === "\\0virtual:test/worker") {
          return "export default { fetch() { return new Response('${MARKER}'); } };";
        }
      },
    },
  ],
};
`;

layer(NodeServices.layer)("resolveViteMain", (it) => {
  it.effect(
    "absolutizes explicitly relative entries against the Vite root (#796)",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(resolveViteMain(path, root, "./src/worker.ts")).toBe(
          "/repo/apps/agents/src/worker.ts",
        );
        expect(resolveViteMain(path, root, "../shared/worker.ts")).toBe(
          "/repo/apps/shared/worker.ts",
        );
      }),
  );

  it.effect("keeps module ids and bare specifiers for Vite to resolve", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveViteMain(path, root, "virtual:flue/worker")).toBe(
        "virtual:flue/worker",
      );
      expect(resolveViteMain(path, root, "src/worker.ts")).toBe(
        "src/worker.ts",
      );
    }),
  );

  it.effect("passes absolute and absent entries through", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveViteMain(path, root, "/abs/worker.ts")).toBe(
        "/abs/worker.ts",
      );
      expect(resolveViteMain(path, root, undefined)).toBeUndefined();
    }),
  );

  it.effect(
    "builds a Worker whose entry is a plugin-provided virtual module",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const rootDir = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-vite-main-virtual-",
          });
          yield* fs.writeFileString(
            path.join(rootDir, "package.json"),
            JSON.stringify({ private: true, type: "module" }),
          );
          yield* fs.writeFileString(
            path.join(rootDir, "vite.config.mjs"),
            virtualEntryConfig,
          );

          const result = yield* runViteBuildChild(
            {
              rootDir,
              env: {},
              main: resolveViteMain(path, rootDir, "virtual:test/worker"),
              compatibilityDate: "2026-01-01",
              compatibilityFlags: undefined,
              viteEnvironments: undefined,
            },
            () => Effect.void,
          );

          const entry = result.serverBundle?.files[0];
          expect(entry).toBeDefined();
          const content =
            typeof entry!.content === "string"
              ? entry!.content
              : new TextDecoder().decode(entry!.content);
          expect(content).toContain(MARKER);
        }),
      ),
    { timeout: 90_000 },
  );
});
