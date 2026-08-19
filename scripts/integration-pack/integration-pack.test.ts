import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { integrationClosure } from "./graph.ts";
import { pnpmPackCommand } from "./pack.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");

describe("integration package graph", () => {
  test("orders local dependencies before Alchemy and resolves catalog-local edges", async () => {
    const closure = await integrationClosure(repositoryRoot);
    const names = closure.map((workspace) => workspace.name);
    const position = (name: string): number => {
      const index = names.indexOf(name);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };

    expect(position("@distilled.cloud/core")).toBeLessThan(
      position("@distilled.cloud/aws"),
    );
    expect(position("@distilled.cloud/cloudflare")).toBeLessThan(
      position("@alchemy.run/cloudflare-runtime"),
    );
    expect(position("@alchemy.run/cloudflare-runtime")).toBeLessThan(
      position("alchemy"),
    );
  });

  test("ships every tree referenced by selected Distilled runtime exports", async () => {
    const closure = await integrationClosure(repositoryRoot);
    for (const name of [
      "@distilled.cloud/axiom",
      "@distilled.cloud/cloudflare",
      "@distilled.cloud/neon",
      "@distilled.cloud/planetscale",
    ]) {
      const workspace = closure.find((candidate) => candidate.name === name);
      expect(workspace?.manifest.files).toContain("lib");
      expect(workspace?.manifest.files).toContain("src");
    }
  });
});

describe("integration package packing", () => {
  test("disables lifecycle scripts with pnpm's explicit config option", () => {
    expect(pnpmPackCommand("/tmp/output")).toEqual([
      "pnpm",
      "--config.ignore-scripts=true",
      "--config.node-linker=hoisted",
      "pack",
      "--pack-destination",
      "/tmp/output",
    ]);
  });
});
