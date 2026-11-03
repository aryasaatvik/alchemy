import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@alchemy.run/test";

// A Node service that imports the provider root (a deployed API, say) and
// never deploys a website does not install the optional framework peer. Its
// bundle must not need that peer to resolve.
const optionalFrameworkPeer = /^@alchemy\.run\/frontend-frameworks(\/|$)/;

// Runtime peers a Node host supplies when it uses them; out of scope here.
const hostSuppliedPeers = ["@effect/platform-bun", "react-devtools-core"];

describe("@alchemy.run/aws root bundle", () => {
  it(
    "bundles for Node without the optional frontend-frameworks peer",
    async () => {
      // Inside this package so the entry resolves the workspace provider.
      const dir = await mkdtemp(fileURLToPath(new URL("./.root-bundle-", import.meta.url)));
      try {
        const entry = join(dir, "entry.ts");
        await writeFile(entry, 'import * as AWS from "@alchemy.run/aws";\nconsole.log(AWS);\n');
        const unresolved: string[] = [];
        const result = await Bun.build({
          entrypoints: [entry],
          target: "node",
          external: hostSuppliedPeers,
          throw: false,
          plugins: [
            {
              name: "without-optional-framework-peer",
              setup(build) {
                build.onResolve({ filter: optionalFrameworkPeer }, (args) => {
                  unresolved.push(`${args.importer} -> ${args.path}`);
                  throw new Error(`${args.path} is not installed`);
                });
              },
            },
          ],
        });
        expect(unresolved).toEqual([]);
        expect(result.logs.filter((log) => log.level === "error")).toEqual([]);
        expect(result.success).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );
});
