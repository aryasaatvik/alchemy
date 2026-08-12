import path from "node:path";
import { describe, expect, test } from "alchemy-test";
import { resolveViteMain } from "../../../src/Cloudflare/Workers/ViteMain.ts";

describe("resolveViteMain", () => {
  const root = path.join(path.sep, "workspace", "worker");

  test("resolves file entries from the Vite root", () => {
    expect(resolveViteMain(root, "src/index.ts")).toBe(
      path.join(root, "src/index.ts"),
    );
  });

  test("preserves framework-owned virtual entries", () => {
    expect(resolveViteMain(root, "virtual:flue/worker")).toBe(
      "virtual:flue/worker",
    );
    expect(resolveViteMain(root, "\0framework:worker")).toBe(
      "\0framework:worker",
    );
  });
});
