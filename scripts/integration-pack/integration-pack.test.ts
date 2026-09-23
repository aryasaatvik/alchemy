import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { packageFingerprint } from "./fingerprint.ts";
import { integrationClosure, workspaceEffectVersion } from "./graph.ts";
import { readManifest, run } from "./io.ts";
import {
  pnpmInstallCommand,
  pnpmPackCommand,
  repositoryPnpmVersion,
} from "./pack.ts";
import {
  findExistingUpload,
  parsePackResult,
  parseUploadResult,
} from "./checkpoint.ts";
import {
  assertPublishableManifest,
  assertExportTargets,
  assertSafeArchiveEntries,
  makeBundledPackagesSelfContained,
  patchIntegrationManifest,
  stageAndPack,
  unownedPublishedFiles,
} from "./staging.ts";
import {
  assertBundledFiles,
  assertConsumerSubpaths,
  consumerSubpaths,
  resolveExportSubpath,
} from "./verify.ts";

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
        "@distilled.cloud/acme",
        "@distilled.cloud/aws",
        "@distilled.cloud/axiom",
        "@distilled.cloud/cloudflare",
        "@distilled.cloud/core",
        "@distilled.cloud/doppler",
        "@distilled.cloud/fly-io",
        "@distilled.cloud/hetzner",
        "@distilled.cloud/infisical",
        "@distilled.cloud/neon",
        "@distilled.cloud/planetscale",
        "@distilled.cloud/prisma",
        "@distilled.cloud/railway",
        "@distilled.cloud/stripe",
        "@distilled.cloud/zerossl",
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

/** Real workspace packages live in a Git checkout; fixtures mirror that. */
const trackAll = async (directory: string): Promise<void> => {
  await run(["git", "init", "--quiet"], { cwd: directory });
  await run(["git", "add", "--all"], { cwd: directory });
};

describe("integration package staging", () => {
  test("suppresses lifecycle scripts and uses a hoisted pnpm layout", () => {
    expect(pnpmInstallCommand("11.25.0")).toEqual([
      "pnpm",
      "with",
      "11.25.0",
      "--config.ignore-scripts=true",
      "--config.node-linker=hoisted",
      "install",
      "--prod",
    ]);
    expect(pnpmPackCommand("11.25.0", "/tmp/output")).toEqual([
      "pnpm",
      "with",
      "11.25.0",
      "--config.ignore-scripts=true",
      "--config.node-linker=hoisted",
      "pack",
      "--pack-destination",
      "/tmp/output",
    ]);
  });

  test("stages with the repository's pinned pnpm, not the global one", async () => {
    const manifest = await readManifest(
      resolve(repositoryRoot, "package.json"),
    );
    expect(`pnpm@${await repositoryPnpmVersion(repositoryRoot)}`).toBe(
      manifest.packageManager!,
    );
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
      resolve(repositoryRoot, "submodules/distilled/packages/core"),
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

  test("sanitizes devDependencies from cached bundled package manifests", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "integration-bundled-manifest-"),
    );
    try {
      const packageDirectory = join(
        directory,
        "node_modules",
        "@fixture",
        "local",
      );
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        join(packageDirectory, "package.json"),
        `${JSON.stringify({
          name: "@fixture/local",
          version: "1.0.0",
          devDependencies: { typescript: "^7.0.0" },
        })}\n`,
      );
      await makeBundledPackagesSelfContained(directory, [
        {
          name: "@fixture/local",
          version: "1.0.0",
          tarball: "/tmp/fixture.tgz",
          fingerprint: "fixture",
        },
      ]);

      const manifest = await readManifest(
        join(packageDirectory, "package.json"),
      );
      expect(manifest.devDependencies).toBeUndefined();
      expect(manifest.dependencies).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("treats only untracked files in source roots as unowned", () => {
    const tracked = new Set(["package.json", "bin/cli.js", "src/index.ts"]);
    expect(
      unownedPublishedFiles(
        [
          "package.json",
          "bin/cli.js",
          "src/index.ts",
          // Build output roots and copied metadata are owned by the build.
          "lib/index.js",
          "lib/index.d.ts",
          "LICENSE",
          "NOTICE",
          // Stale output left in source roots is not.
          "bin/cli.d.ts",
          "bin/cli.js.map",
          "src/index.d.ts",
          "stray.txt",
        ],
        tracked,
      ),
    ).toEqual([
      "bin/cli.d.ts",
      "bin/cli.js.map",
      "src/index.d.ts",
      "stray.txt",
    ]);
  });

  test("refuses to pack stale ignored files from a source root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-stale-stage-"));
    const output = await mkdtemp(join(tmpdir(), "integration-stale-output-"));
    try {
      await mkdir(join(directory, "bin"));
      await mkdir(join(directory, "lib"));
      await writeFile(join(directory, ".gitignore"), "lib/\n*.d.ts\n*.map\n");
      await writeFile(join(directory, "bin", "cli.js"), "export {};\n");
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          type: "module",
          files: ["bin", "lib"],
        })}\n`,
      );
      await trackAll(directory);
      // Build outputs: an untracked output root and copied metadata.
      await writeFile(join(directory, "lib", "index.js"), "export {};\n");
      await writeFile(join(directory, "LICENSE"), "MIT\n");
      const input = {
        repositoryRoot,
        pnpmVersion: await repositoryPnpmVersion(repositoryRoot),
        workspace: {
          name: "fixture",
          directory,
          manifest: { name: "fixture" },
          localDependencies: [],
        },
        localPackages: [],
        version: "1.0.0-samva.test",
        outputDir: output,
        bundleLocalPackages: false,
      } as const;

      await stageAndPack(input);

      // Ignored output an old build left in `bin/` survives `git reset
      // --hard`, and `files: ["bin"]` would ship it.
      await writeFile(join(directory, "bin", "cli.d.ts"), "export {};\n");
      await writeFile(join(directory, "bin", "cli.js.map"), "{}\n");
      const rejection = await stageAndPack(input).then(
        () => undefined,
        (error: Error) => error.message,
      );
      expect(rejection).toContain("fixture would publish files");
      expect(rejection).toContain(join(directory, "bin", "cli.d.ts"));
      expect(rejection).toContain(join(directory, "bin", "cli.js.map"));
      expect(rejection).not.toContain(join(directory, "lib", "index.js"));
    } finally {
      await Promise.all([
        rm(directory, { recursive: true, force: true }),
        rm(output, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);

  test("produces byte-identical archives across repeated stage builds", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "integration-repeat-stage-"),
    );
    const output = await mkdtemp(join(tmpdir(), "integration-repeat-output-"));
    try {
      await mkdir(join(directory, "src"));
      await writeFile(
        join(directory, "src", "index.js"),
        "export const value = 1;\n",
      );
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          type: "module",
          files: ["src"],
          devDependencies: { typescript: "^7.0.0" },
        })}\n`,
      );
      await trackAll(directory);
      const input = {
        repositoryRoot,
        pnpmVersion: await repositoryPnpmVersion(repositoryRoot),
        workspace: {
          name: "fixture",
          directory,
          manifest: { name: "fixture" },
          localDependencies: [],
        },
        localPackages: [],
        version: "1.0.0-samva.test",
        outputDir: output,
        bundleLocalPackages: false,
      } as const;

      const firstPath = await stageAndPack(input);
      const first = await readFile(firstPath);
      const secondPath = await stageAndPack(input);
      const second = await readFile(secondPath);

      expect(second).toEqual(first);
    } finally {
      await Promise.all([
        rm(directory, { recursive: true, force: true }),
        rm(output, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);
});

describe("integration consumer surface", () => {
  test("resolves subpaths like Node: exact keys, then the longest wildcard prefix", () => {
    const exports = {
      ".": "./src/index.ts",
      "./*": "./src/*.ts",
      "./AWS/*": "./src/AWS/*/index.ts",
      "./AWS/Lambda/*": "./src/AWS/Lambda/*.ts",
      "./AWS/Endpoint": "./src/AWS/Endpoint.ts",
      "./Prisma/Refs": null,
    };
    expect(resolveExportSubpath(exports, ".")).toBe("./src/index.ts");
    expect(resolveExportSubpath(exports, "./Output")).toBe("./src/Output.ts");
    expect(resolveExportSubpath(exports, "./AWS/S3")).toBe(
      "./src/AWS/S3/index.ts",
    );
    expect(resolveExportSubpath(exports, "./AWS/Lambda/Durable")).toBe(
      "./src/AWS/Lambda/Durable.ts",
    );
    expect(resolveExportSubpath(exports, "./AWS/Endpoint")).toBe(
      "./src/AWS/Endpoint.ts",
    );
    expect(resolveExportSubpath(exports, "./Prisma/Refs")).toBeNull();
  });

  test("rejects a consumer subpath the packed export map cannot serve", () => {
    const manifest = {
      name: "alchemy",
      exports: {
        "./AWS/*": {
          types: "./lib/AWS/*/index.d.ts",
          bun: "./src/AWS/*/index.ts",
          default: "./lib/AWS/*/index.js",
        },
      },
    };
    const entries = new Set([
      "package/lib/AWS/S3/index.d.ts",
      "package/src/AWS/S3/index.ts",
      "package/lib/AWS/S3/index.js",
    ]);
    expect(() =>
      assertConsumerSubpaths(entries, manifest, ["alchemy/AWS/S3"]),
    ).not.toThrow();
    expect(() =>
      assertConsumerSubpaths(entries, manifest, ["alchemy/AWS/Endpoint"]),
    ).toThrow("resolves to missing packaged file");
    expect(() =>
      assertConsumerSubpaths(entries, manifest, ["alchemy/Output"]),
    ).toThrow("is not exported");
  });

  test("rejects a bundled package that is not the local build", () => {
    const local = [
      "package/package.json",
      "package/src/api.ts",
      "package/src/xml.ts",
    ];
    const bundled = new Set([
      "package/node_modules/@distilled.cloud/core/package.json",
      "package/node_modules/@distilled.cloud/core/src/api.ts",
    ]);
    expect(() =>
      assertBundledFiles(bundled, "@distilled.cloud/core", local),
    ).toThrow("not the local build");
    bundled.add("package/node_modules/@distilled.cloud/core/src/xml.ts");
    expect(() =>
      assertBundledFiles(bundled, "@distilled.cloud/core", local),
    ).not.toThrow();
  });

  test("every Samva subpath is published from existing source", async () => {
    const directory = resolve(repositoryRoot, "packages/alchemy");
    const manifest = await readManifest(resolve(directory, "package.json"));
    const published = (manifest.publishConfig as { exports: unknown }).exports;
    for (const specifier of consumerSubpaths) {
      const subpath =
        specifier === "alchemy"
          ? "."
          : `./${specifier.slice("alchemy/".length)}`;
      const resolved = resolveExportSubpath(published, subpath) as
        | Record<string, string>
        | undefined;
      expect(resolved, specifier).toBeDefined();
      expect(
        await Bun.file(resolve(directory, resolved!.bun!)).exists(),
        specifier,
      ).toBe(true);
    }
  });

  test("installs the workspace's exact Effect version beside the artifact", async () => {
    expect(await workspaceEffectVersion(repositoryRoot)).toMatch(
      /^4\.0\.0-rc\.\d+$/,
    );
  });
});

describe("integration checkpoint", () => {
  const result = {
    artifact: "/tmp/alchemy-2.0.0-samva.abc123.fingerprint.tgz",
    sha256: "a".repeat(64),
    version: "2.0.0-samva.abc123.fingerprint",
  };

  test("parses the exact artifact identity reported by the packer", () => {
    expect(
      parsePackResult(
        `Created ${result.artifact}\nVersion ${result.version}\nSHA256 ${result.sha256}\nConsumer dependency: ignored`,
      ),
    ).toEqual(result);
  });

  test("rejects incomplete packer output", () => {
    expect(() => parsePackResult(`Created ${result.artifact}`)).toThrow(
      "did not report one artifact, version, and SHA-256 digest",
    );
  });

  test("reuses the newest upload with the same filename and digest", () => {
    expect(
      findExistingUpload(
        [
          {
            id: "older",
            filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
            contentHash: result.sha256,
            url: "https://scratchpad.example/older",
            createdAt: "2026-08-20T00:00:00.000Z",
          },
          {
            id: "different-content",
            filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
            contentHash: "b".repeat(64),
            url: "https://scratchpad.example/different",
            createdAt: "2026-08-22T00:00:00.000Z",
          },
          {
            id: "newer",
            filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
            contentHash: result.sha256,
            url: "https://scratchpad.example/newer",
            createdAt: "2026-08-21T00:00:00.000Z",
          },
        ],
        result,
      )?.url,
    ).toBe("https://scratchpad.example/newer");
  });

  test("validates Scratchpad's upload response envelope", () => {
    expect(
      parseUploadResult(
        JSON.stringify({
          target: { profile: "production" },
          uploads: [
            {
              filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
              sha256: result.sha256,
              url: "https://scratchpad.example/checkpoint",
            },
          ],
        }),
        result,
      ).url,
    ).toBe("https://scratchpad.example/checkpoint");
  });

  test("rejects a Scratchpad response for different content", () => {
    expect(() =>
      parseUploadResult(
        JSON.stringify({
          uploads: [
            {
              filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
              sha256: "b".repeat(64),
              url: "https://scratchpad.example/checkpoint",
            },
          ],
        }),
        result,
      ),
    ).toThrow("did not match the verified integration artifact");
  });
});
