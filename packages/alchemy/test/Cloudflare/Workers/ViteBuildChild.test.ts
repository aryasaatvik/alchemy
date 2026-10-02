import { runViteBuildChild } from "@/Cloudflare/Workers/ViteChild.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const MARKER = "vite-build-child-config-resolved-marker";

// A plugin that throws while Vite resolves the config — before any build
// starts, so Vite itself logs nothing about the failure.
const throwingConfig = `export default {
  plugins: [
    {
      name: "throws-in-config-resolved",
      configResolved() {
        throw new Error(${JSON.stringify(MARKER)});
      },
    },
  ],
};
`;

layer(NodeServices.layer)("runViteBuildChild", (it) => {
  it.effect(
    "surfaces an error thrown in configResolved in the BundleError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const rootDir = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-vite-build-child-error-",
          });
          yield* fs.writeFileString(
            path.join(rootDir, "package.json"),
            JSON.stringify({ private: true, type: "module" }),
          );
          yield* fs.writeFileString(
            path.join(rootDir, "vite.config.mjs"),
            throwingConfig,
          );

          const error = yield* runViteBuildChild(
            {
              rootDir,
              env: {},
              main: undefined,
              compatibilityDate: "2026-01-01",
              compatibilityFlags: undefined,
              viteEnvironments: undefined,
            },
            () => Effect.void,
          ).pipe(Effect.flip);

          expect(error._tag).toBe("BundleError");
          expect(error.message).toContain(MARKER);
          // Printed once by the child, not once more by an Effect failure
          // report.
          expect(error.message.split(MARKER).length - 1).toBe(1);
        }),
      ),
    { timeout: 60_000 },
  );
});
