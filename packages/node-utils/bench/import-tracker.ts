import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Fresh processes avoid Bun's evaluated-module cache; the fixture has no provider side effects.
const count = Number(process.argv[2] ?? 800);
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "alchemy-import-bench-")));
try {
  for (let i = 0; i < count; i++)
    writeFileSync(path.join(root, `module-${i}.ts`), `export const value = ${i};`);
  const entry = path.join(root, "entry.ts");
  writeFileSync(
    entry,
    Array.from(
      { length: count },
      (_, i) => `export { value as value${i} } from "./module-${i}.ts";`,
    ).join("\n"),
  );
  for (const tracked of [false, true]) {
    for (let run = 1; run <= 3; run++) {
      const script = `
        import { trackBunImports } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/watch/bun-import-tracker.ts"))};
        const tracker = ${tracked} ? trackBunImports({root: ${JSON.stringify(root)}}) : undefined;
        const start = performance.now();
        await import(${JSON.stringify(entry)});
        console.log(JSON.stringify({tracked: ${tracked}, run: ${run}, modules: ${count + 1}, importMs: performance.now()-start, dependencies: tracker?.dependencies.size}));
        await tracker?.close();
      `;
      const child = Bun.spawn([process.execPath, "--eval", script], {
        stdout: "pipe",
        stderr: "inherit",
      });
      console.log((await new Response(child.stdout).text()).trim());
      if ((await child.exited) !== 0) throw new Error("benchmark child failed");
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
