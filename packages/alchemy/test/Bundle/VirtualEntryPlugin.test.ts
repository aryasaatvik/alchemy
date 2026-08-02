import * as Bundle from "@/Bundle/Bundle";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

layer(NodeServices.layer)("virtualEntryPlugin", (it) => {
  it.effect(
    "resolves Alchemy private dependencies from Alchemy's package graph",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-virtual-entry-",
        });
        const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

        try {
          const result = yield* Bundle.build({
            cwd: root,
            input: "entry.ts",
            platform: "node",
            plugins: [
              virtualEntryPlugin(
                () => `
import { fromCredentials } from "@distilled.cloud/aws/Credentials";
export default fromCredentials;
`,
              ),
            ],
          });

          const code = result.files
            .filter((file) => typeof file.content === "string")
            .map((file) => file.content)
            .join("\n");

          expect(code).not.toContain("@distilled.cloud/aws/Credentials");
        } finally {
          yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        }
      }),
  );

  it.effect(
    "resolves Alchemy private dependencies from non-virtual modules",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-private-dependency-",
        });
        const entry = `${root}/entry.ts`;

        try {
          yield* fs.writeFileString(
            entry,
            `
import { fromCredentials } from "@distilled.cloud/aws/Credentials";
export default fromCredentials;
`,
          );
          const result = yield* Bundle.build({
            cwd: root,
            input: entry,
            platform: "node",
          });

          const code = result.files
            .filter((file) => typeof file.content === "string")
            .map((file) => file.content)
            .join("\n");

          expect(code).not.toContain("@distilled.cloud/aws/Credentials");
        } finally {
          yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        }
      }),
  );
});
