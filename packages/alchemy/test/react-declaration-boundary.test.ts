import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@alchemy.run/test";

// React's types declare global DOM interfaces (an empty `HTMLElement`, for
// one), so any core declaration that imports them reshapes every consumer's
// global scope. React stays behind the `Cli` renderer: core modules neither
// import React nor statically import a `Cli` module. A dynamic `import()` of
// the renderer does not reach the declaration graph.
const src = fileURLToPath(new URL("../src/", import.meta.url));
const cli = path.join(src, "Cli");

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return file === cli ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });

const staticSpecifiers = (text: string): string[] =>
  [
    ...text.matchAll(
      /(?:^|\n)\s*(?:import|export)\b[^;'"()]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    ),
  ].map((match) => (match[1] ?? match[2])!);

describe("React declaration boundary", { tags: ["unit", "local"] }, () => {
  test("core modules keep React and the Cli renderer out of their static imports", () => {
    const violations = sourceFiles(src).flatMap((file) =>
      staticSpecifiers(fs.readFileSync(file, "utf8"))
        .filter(
          (specifier) =>
            specifier === "react" ||
            specifier.startsWith("react/") ||
            (specifier.startsWith(".") &&
              path.resolve(path.dirname(file), specifier).startsWith(cli + path.sep)),
        )
        .map((specifier) => `${path.relative(src, file)} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });
});
