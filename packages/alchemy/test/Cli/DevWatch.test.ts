import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@alchemy.run/test";
import { DevCli } from "@alchemy.run/test/DevCli";

const cli = fileURLToPath(new URL("../../bin/cli.js", import.meta.url));
const stack = new URL("./fixtures/data-dir-stack.ts", import.meta.url).href;

describe("dev stack watching", { tags: ["unit", "local"] }, () => {
  for (const watch of [undefined, "false"]) {
    test(
      `dependency edits with ALCHEMY_DEV_WATCH=${watch ?? "default"}`,
      async () => {
        const root = await mkdtemp(path.join(tmpdir(), "alchemy-dev-watch-"));
        const marker = path.join(root, "evaluated.txt");
        const dependency = path.join(root, "dependency.ts");
        await writeFile(dependency, 'export const value = "first";');
        await writeFile(
          path.join(root, "alchemy.run.ts"),
          [
            'import { value } from "./dependency.ts";',
            `await Bun.write(${JSON.stringify(marker)}, value);`,
            `export { default } from ${JSON.stringify(stack)};`,
          ].join("\n"),
        );
        const dev = new DevCli({
          root,
          alchemyBin: cli,
          env: {
            ALCHEMY_HOME: path.join(root, "home"),
            ALCHEMY_DEV_ONCE: "false",
            ALCHEMY_DEV_WATCH: watch,
            ALCHEMY_TUI: "false",
          },
        });
        try {
          dev.start();
          await dev.pollUntil("initial stack evaluation", async () =>
            (await readFile(marker, "utf8").catch(() => "")) === "first" ? true : undefined,
          );
          // Wait for apply, so this proves the dev run stays alive after apply.
          await dev.pollUntil("stack apply", async () =>
            (await readFile(
              path.join(
                root,
                ".alchemy",
                "state",
                "CliDataDir",
                "dev-cli-test",
                "__stack_output__.json",
              ),
              "utf8",
            ).catch(() => ""))
              ? true
              : undefined,
          );
          await writeFile(dependency, 'export const value = "second";');
          if (watch === undefined) {
            await dev.pollUntil("changed dependency reload", async () =>
              (await readFile(marker, "utf8")) === "second" ? true : undefined,
            );
            expect(dev.output).toContain("Reloading stack");
          } else {
            await Bun.sleep(500);
            expect(await readFile(marker, "utf8")).toBe("first");
            expect(dev.output).not.toContain("Reloading stack");
            await dev.pollUntil("live immutable run", () => true);
          }
        } finally {
          await dev.stop();
          await rm(root, { recursive: true, force: true });
        }
      },
      { timeout: 60_000 },
    );
  }
});
