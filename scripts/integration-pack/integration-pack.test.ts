import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { packageFingerprint } from "./fingerprint.ts";
import { integrationClosure } from "./graph.ts";
import { readManifest } from "./io.ts";
import { pnpmInstallCommand, pnpmPackCommand } from "./pack.ts";
import {
  assertPublishableManifest,
  assertExportTargets,
  assertSafeArchiveEntries,
  patchIntegrationManifest,
} from "./staging.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");

describe("integration package graph", () => {
  test("returns the complete current closure in dependency order", async () => {
    const closure = await integrationClosure(repositoryRoot);
    const names = closure.map((workspace) => workspace.name);

    expect(new Set(names)).toEqual(
      new Set([
        "@alchemy.run/cloudflare-runtime",
        "@alchemy.run/floci",
        "@alchemy.run/frontend-frameworks",
        "@alchemy.run/node-utils",
        "@distilled.cloud/aws",
        "@distilled.cloud/axiom",
        "@distilled.cloud/cloudflare",
        "@distilled.cloud/core",
        "@distilled.cloud/fly-io",
        "@distilled.cloud/hetzner",
        "@distilled.cloud/neon",
        "@distilled.cloud/otel-collector",
        "@distilled.cloud/planetscale",
        "alchemy",
      ]),
    );
    const position = (name: string): number => {
      const index = names.indexOf(name);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    for (const workspace of closure) {
      for (const dependency of workspace.localDependencies) {
        expect(position(dependency)).toBeLessThan(position(workspace.name));
      }
    }
  });

  test("ships source and compiled trees for every Distilled package", async () => {
    const closure = await integrationClosure(repositoryRoot);
    for (const workspace of closure.filter((candidate) =>
      candidate.name.startsWith("@distilled.cloud/"),
    )) {
      expect(workspace.manifest.files).toContain("lib");
      expect(workspace.manifest.files).toContain("src");
    }
  });
});

describe("integration package staging", () => {
  test("suppresses lifecycle scripts and uses a hoisted pnpm layout", () => {
    expect(pnpmInstallCommand()).toEqual([
      "pnpm",
      "--config.ignore-scripts=true",
      "--config.node-linker=hoisted",
      "install",
      "--prod",
    ]);
    expect(pnpmPackCommand("/tmp/output")).toEqual([
      "pnpm",
      "--config.ignore-scripts=true",
      "--config.node-linker=hoisted",
      "pack",
      "--pack-destination",
      "/tmp/output",
    ]);
  });

  test("rejects unresolved local dependency protocols", () => {
    for (const specifier of ["workspace:*", "catalog:effect", "file:x.tgz"]) {
      expect(() =>
        assertPublishableManifest("fixture", {
          dependencies: { dependency: specifier },
        }),
      ).toThrow("unresolved dependencies.dependency");
    }
  });

  test("invalidates the cache when package build configuration changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-fingerprint-"));
    try {
      await mkdir(join(directory, "src"));
      await writeFile(
        join(directory, "src", "index.ts"),
        "export const value = 1;\n",
      );
      await writeFile(join(directory, "package.json"), '{"name":"fixture"}\n');
      await writeFile(
        join(directory, "tsconfig.json"),
        '{"compilerOptions":{}}\n',
      );
      const workspace = {
        name: "fixture",
        directory,
        manifest: { name: "fixture" },
        localDependencies: [],
      } as const;
      const before = await packageFingerprint(directory, workspace, {});
      await writeFile(
        join(directory, "tsconfig.json"),
        '{"compilerOptions":{"target":"ESNext"}}\n',
      );
      const after = await packageFingerprint(directory, workspace, {});
      expect(after).not.toBe(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("requires wildcard exports to match a packaged file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-exports-"));
    try {
      await mkdir(join(directory, "lib", "services"), { recursive: true });
      await expect(
        assertExportTargets("fixture", directory, {
          exports: { "./services/*": "./lib/services/*.js" },
        }),
      ).rejects.toThrow("missing runtime export");
      await writeFile(
        join(directory, "lib", "services", "s3.js"),
        "export {};\n",
      );
      await expect(
        assertExportTargets("fixture", directory, {
          exports: { "./services/*": "./lib/services/*.js" },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects archive path traversal before extraction", () => {
    expect(() => assertSafeArchiveEntries(["package/../outside"])).toThrow(
      "unsafe path",
    );
    expect(() =>
      assertSafeArchiveEntries(["package/src/index.ts"]),
    ).not.toThrow();
  });

  test("patches known missing Distilled exports only in staging", async () => {
    const manifest = await patchIntegrationManifest(
      resolve(repositoryRoot, "distilled/packages/core"),
      {
        name: "@distilled.cloud/core",
        exports: {
          ".": { bun: "./src/index.ts", import: "./lib/index.js" },
          "./api": { bun: "./src/api.ts", import: "./lib/api.js" },
        },
      },
    );
    expect(manifest.exports).toEqual({
      "./api": { bun: "./src/api.ts", import: "./lib/api.js" },
    });
  });

  test("omits only known invalid Alchemy subpaths from the staged manifest", async () => {
    const directory = resolve(repositoryRoot, "packages/alchemy");
    const source = await readManifest(resolve(directory, "package.json"));
    const staged = await patchIntegrationManifest(directory, source);
    const exports = staged.exports as Record<string, unknown>;

    for (const subpath of [
      "./Construct",
      "./ContentType",
      "./Cli/InkCLI",
      "./Cloudflare/Live",
      "./Endpoint",
      "./Process",
      "./TUI",
    ]) {
      expect(exports[subpath]).toBeUndefined();
    }
    expect(exports["./AWS"]).toEqual(
      (source.exports as Record<string, unknown>)["./AWS"],
    );
  });
});
