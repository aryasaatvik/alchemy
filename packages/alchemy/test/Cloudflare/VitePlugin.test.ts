import {
  hasActiveVitePluginOptions,
  withVitePluginOptions,
} from "@/Cloudflare/VitePlugin/index.ts";
import { expect, it } from "alchemy-test";

it("scopes nested Vite plugin options to the build action", async () => {
  expect(hasActiveVitePluginOptions()).toBe(false);

  await withVitePluginOptions({ main: "src/worker.ts" }, async () => {
    expect(hasActiveVitePluginOptions()).toBe(true);
    await withVitePluginOptions({ main: "src/nested.ts" }, async () => {
      expect(hasActiveVitePluginOptions()).toBe(true);
    });
    expect(hasActiveVitePluginOptions()).toBe(true);
  });

  expect(hasActiveVitePluginOptions()).toBe(false);
});
