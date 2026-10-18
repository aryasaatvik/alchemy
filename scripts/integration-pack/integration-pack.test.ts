import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withCleanBuildOutputs, packageBuildOutputs } from "./build.ts";
import { findExistingUpload, parsePackResult, parseUploadResult } from "./checkpoint.ts";
import {
  assertBuildInputsUnchanged,
  packageFingerprint,
  snapshotBuildInputs,
} from "./fingerprint.ts";
import { integrationClosure, workspaceEffectVersion } from "./graph.ts";
import { readManifest, run } from "./io.ts";
import {
  packageBuildScript,
  pnpmInstallCommand,
  pnpmPackCommand,
  repositoryPnpmVersion,
} from "./pack.ts";
import {
  assertPublishableManifest,
  assertExportTargets,
  assertSafeArchiveEntries,
  makeBundledPackagesSelfContained,
  patchIntegrationManifest,
  promoteBundledRuntimeDependencies,
  stageAndPack,
  unownedPublishedFiles,
} from "./staging.ts";
import type { PackageManifest } from "./types.ts";
import {
  assertBundledFiles,
  assertConsumerSubpaths,
  consumerSubpaths,
  freshConsumerManifest,
  resolveExportSubpath,
} from "./verify.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");

describe("fresh integration consumer", () => {
  test("installs the declared Vite host peer for the public Vite integration", () => {
    const manifest = freshConsumerManifest(
      "/tmp/alchemy.tgz",
      { peerDependencies: { vite: "^7.0.0 || ^8.0.0" } },
      { effect: "4.0.4" },
    );
    expect(manifest.dependencies?.vite).toBe("^7.0.0 || ^8.0.0");
    expect(manifest.dependencies?.alchemy).toBe("file:/tmp/alchemy.tgz");
    expect(manifest.overrides?.["@effect/platform-node-shared"]).toBe("4.0.4");
  });

  test("rejects a missing or unresolved Vite peer instead of inventing a host", () => {
    expect(() => freshConsumerManifest("/tmp/alchemy.tgz", {}, { effect: "4.0.4" })).toThrow(
      "must declare its Vite host peer",
    );
    expect(() =>
      freshConsumerManifest(
        "/tmp/alchemy.tgz",
        { peerDependencies: { vite: "catalog:" } },
        { effect: "4.0.4" },
      ),
    ).toThrow("unresolved peerDependencies.vite");
  });
});

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
        "@distilled.cloud/gcp",
        "@distilled.cloud/hetzner",
        "@distilled.cloud/infisical",
        "@distilled.cloud/iceberg",
        "@distilled.cloud/neon",
        "@distilled.cloud/planetscale",
        "@distilled.cloud/prisma",
        "@distilled.cloud/railway",
        "@distilled.cloud/stripe",
        "@distilled.cloud/turso",
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

describe("integration build provenance", () => {
  test("rejects a build that rewrites a manifest already marked dirty before caching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-dirty-build-"));
    try {
      await cp(
        join(repositoryRoot, "scripts", "integration-pack"),
        join(directory, "scripts", "integration-pack"),
        { recursive: true },
      );
      const packageDirectory = join(directory, "packages", "alchemy");
      await mkdir(join(packageDirectory, "scripts"), { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          private: true,
          packageManager: `pnpm@${await repositoryPnpmVersion(repositoryRoot)}`,
        }),
      );
      await writeFile(
        join(directory, "pnpm-workspace.yaml"),
        'packages: ["packages/*"]\noverrides: { effect: "4.0.4" }\n',
      );
      await writeFile(join(directory, ".gitignore"), "artifacts/\nnode_modules\n");
      await symlink(join(repositoryRoot, "node_modules"), join(directory, "node_modules"), "dir");
      await mkdir(join(packageDirectory, "src"));
      await writeFile(join(packageDirectory, "src", "index.ts"), "export {};\n");
      await writeFile(
        join(packageDirectory, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { outDir: "lib" }, files: ["src/index.ts"] }),
      );
      const manifestPath = join(packageDirectory, "package.json");
      const manifest = {
        name: "alchemy",
        version: "1.0.0",
        scripts: { "build:package": "bun scripts/build.ts" },
      };
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(
        join(packageDirectory, "scripts", "build.ts"),
        `const path = new URL("../package.json", import.meta.url);
const manifest = await Bun.file(path).json();
manifest.description = "rewritten by build";
await Bun.write(path, JSON.stringify(manifest));
`,
      );
      await trackAll(directory);
      await run(
        [
          "git",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--no-gpg-sign",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: directory },
      );
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, description: "dirty before build" }),
      );
      const before = await run(["git", "status", "--porcelain", "--untracked-files=no"], {
        cwd: directory,
        quiet: true,
      });
      const child = Bun.spawn(
        [
          process.execPath,
          join(directory, "scripts", "integration-pack", "cli.ts"),
          "--verify",
          "none",
        ],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain("modified packaging inputs");
      expect(
        await run(["git", "status", "--porcelain", "--untracked-files=no"], {
          cwd: directory,
          quiet: true,
        }),
      ).toBe(before);
      expect(
        await Bun.file(
          join(directory, "artifacts", ".integration-pack-cache", "index.json"),
        ).exists(),
      ).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects newly added source inputs as well as already-dirty tracked bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-input-snapshot-"));
    try {
      await mkdir(join(directory, "src"));
      await writeFile(join(directory, "package.json"), '{"name":"fixture"}');
      await writeFile(join(directory, "src", "index.ts"), "export {};\n");
      await trackAll(directory);
      await run(
        [
          "git",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--no-gpg-sign",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: directory },
      );
      const workspaces = [
        { name: "fixture", directory, manifest: { name: "fixture" }, localDependencies: [] },
      ];
      const before = await snapshotBuildInputs(directory, workspaces, "fixture");
      await writeFile(join(directory, "src", "new.ts"), "export const added = true;\n");
      await expect(
        assertBuildInputsUnchanged(directory, workspaces, "fixture", before),
      ).rejects.toThrow("modified packaging inputs");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("integration package staging", () => {
  test("suppresses lifecycle scripts and uses a hoisted pnpm layout", () => {
    expect(pnpmInstallCommand("12.9.1")).toEqual([
      "pnpm",
      "with",
      "12.9.1",
      "--config.ignore-scripts=true",
      "--config.node-linker=hoisted",
      "install",
      "--prod",
    ]);
    expect(pnpmPackCommand("12.9.1", "/tmp/output")).toEqual([
      "pnpm",
      "with",
      "12.9.1",
      "--config.ignore-scripts=true",
      "--config.node-linker=hoisted",
      "pack",
      "--pack-destination",
      "/tmp/output",
    ]);
  });

  test("stages with the repository's pinned pnpm, not the global one", async () => {
    const manifest = await readManifest(resolve(repositoryRoot, "package.json"));
    expect(`pnpm@${await repositoryPnpmVersion(repositoryRoot)}`).toBe(manifest.packageManager!);
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

  test("builds each closure member through its package-only task", () => {
    expect(
      packageBuildScript({ scripts: { build: "recursive", "build:package": "compile" } }),
    ).toBe("build:package");
    expect(packageBuildScript({ scripts: { build: "distilled-build" } })).toBe("build");
    expect(packageBuildScript({ scripts: {} })).toBeUndefined();
  });

  test("invalidates cached packages for build, publication metadata, and skill inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-shared-fingerprint-"));
    try {
      const packageDirectory = join(directory, "packages", "fixture");
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(join(packageDirectory, "package.json"), '{"name":"fixture"}\n');
      const workspace = {
        name: "fixture",
        directory: packageDirectory,
        manifest: { name: "fixture" },
        localDependencies: [],
      };
      for (const input of [
        "scripts/package-build.ts",
        "tsconfig.base.json",
        "tsconfig.cloudflare.json",
        "submodules/distilled/tsconfig.base.json",
        "mise.toml",
        "README.md",
        "packages/fixture/skills/deploy/SKILL.md",
        "packages/fixture/README.md",
        "packages/fixture/LICENSE",
        "packages/fixture/NOTICE",
        "packages/fixture/THIRD_PARTY_LICENSES.md",
        "packages/fixture/.npmignore",
        "packages/fixture/.gitignore",
        ".npmignore",
        ".gitignore",
      ]) {
        const before = await packageFingerprint(directory, workspace, {});
        const path = join(directory, input);
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, "changed input\n");
        expect(await packageFingerprint(directory, workspace, {})).not.toBe(before);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("invalidates the cache when package build configuration changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-fingerprint-"));
    try {
      await mkdir(join(directory, "src"));
      await writeFile(join(directory, "src", "index.ts"), "export const value = 1;\n");
      await writeFile(join(directory, "package.json"), '{"name":"fixture"}\n');
      await writeFile(join(directory, "tsconfig.json"), '{"compilerOptions":{}}\n');
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
      await writeFile(join(directory, "lib", "services", "s3.js"), "export {};\n");
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
    expect(() => assertSafeArchiveEntries(["package/../outside"])).toThrow("unsafe path");
    expect(() => assertSafeArchiveEntries(["package/src/index.ts"])).not.toThrow();
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
    expect(exports["./AWS"]).toEqual((source.exports as Record<string, unknown>)["./AWS"]);
  });

  test("preserves required and optional owners when promoting bundled runtime dependencies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-promoted-edges-"));
    try {
      const bundled = ["optional-first", "required-second"].map((name) => ({
        name,
        version: "1.0.0",
        tarball: "unused.tgz",
        fingerprint: "fixture",
      }));
      for (const packed of bundled)
        await mkdir(join(directory, "node_modules", packed.name), { recursive: true });
      await writeFile(
        join(directory, "node_modules", "optional-first", "package.json"),
        JSON.stringify({
          optionalDependencies: {
            rolldown: "^9.0.0",
            tinyglobby: "^9.0.0",
            shared: "^1.0.0",
            optionalOnly: "^1.0.0",
          },
        }),
      );
      await writeFile(
        join(directory, "node_modules", "required-second", "package.json"),
        JSON.stringify({
          dependencies: {
            rolldown: "^8.0.0",
            tinyglobby: "^8.0.0",
            shared: "^1.0.0",
            ownerOptional: "^2.0.0",
          },
        }),
      );
      const manifest: PackageManifest = {
        dependencies: { rolldown: "1.2.13", tinyglobby: "^0.2.17" },
        optionalDependencies: { ownerOptional: "^1.0.0" },
      };
      await promoteBundledRuntimeDependencies(directory, manifest, bundled);
      expect(manifest.dependencies).toEqual({
        rolldown: "1.2.13",
        tinyglobby: "^0.2.17",
        shared: "^1.0.0",
      });
      expect(manifest.optionalDependencies).toEqual({
        ownerOptional: "^1.0.0",
        optionalOnly: "^1.0.0",
      });
      assertPublishableManifest("fixture", manifest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("cleans obsolete emitted modules and incremental metadata before packing current sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-clean-output-"));
    const output = await mkdtemp(join(tmpdir(), "integration-clean-archive-"));
    try {
      await mkdir(join(directory, "src"));
      await mkdir(join(directory, "scripts"));
      const manifest = {
        name: "clean-output-fixture",
        version: "1.0.0",
        files: ["src", "lib"],
        exports: { ".": "./lib/index.js" },
      };
      await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
      await writeFile(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { composite: true, outDir: "lib", rootDir: "src" },
          files: ["src/index.ts"],
        }),
      );
      await writeFile(join(directory, "src", "index.ts"), "export const current = true;\n");
      await writeFile(
        join(directory, "scripts", "build.ts"),
        `await Bun.write("lib/index.js", await Bun.file("src/index.ts").text());
await Bun.write("tsconfig.tsbuildinfo", "fresh metadata");
`,
      );
      await writeFile(join(directory, ".gitignore"), "lib/\n*.tsbuildinfo\n");
      await trackAll(directory);
      await mkdir(join(directory, "lib"));
      await writeFile(join(directory, "lib", "obsolete.js"), "export const removed = true;\n");
      await writeFile(join(directory, "tsconfig.tsbuildinfo"), "old metadata");
      const workspace = { name: manifest.name, directory, manifest, localDependencies: [] };
      const archive = await withCleanBuildOutputs(workspace, async () => {
        expect(await Bun.file(join(directory, "lib", "obsolete.js")).exists()).toBe(false);
        expect(await Bun.file(join(directory, "tsconfig.tsbuildinfo")).exists()).toBe(false);
        await run([process.execPath, "scripts/build.ts"], { cwd: directory });
        return stageAndPack({
          repositoryRoot: directory,
          pnpmVersion: await repositoryPnpmVersion(repositoryRoot),
          workspace,
          localPackages: [],
          version: "1.0.0",
          outputDir: output,
          bundleLocalPackages: false,
        });
      });
      const entries = (await run(["tar", "-tzf", archive], { cwd: directory, quiet: true })).split(
        "\n",
      );
      expect(entries).toContain("package/lib/index.js");
      expect(entries).not.toContain("package/lib/obsolete.js");
      expect(await Bun.file(join(directory, "tsconfig.tsbuildinfo")).text()).toBe("fresh metadata");

      let backup: string | undefined;
      try {
        await withCleanBuildOutputs(workspace, async () => {
          await Bun.write(join(directory, "lib", "failed.js"), "failed replacement");
          throw new Error("fixture build failure");
        });
        throw new Error("Expected fixture build failure");
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        expect(error.cause).toBeInstanceOf(Error);
        expect(error.message).toContain("original outputs restored");
        backup = /replacement output retained at (.+)$/.exec(error.message)?.[1];
        expect(backup).toBeDefined();
      } finally {
        if (backup !== undefined) await rm(backup, { recursive: true, force: true });
      }
      expect(await Bun.file(join(directory, "lib", "index.js")).text()).toContain("current");
      expect(await Bun.file(join(directory, "lib", "failed.js")).exists()).toBe(false);
      expect(await Bun.file(join(directory, "tsconfig.tsbuildinfo")).text()).toBe("fresh metadata");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  }, 30_000);

  test("refuses output cleanup over tracked files or outside the package", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-unsafe-output-"));
    try {
      await mkdir(join(directory, "src"));
      await mkdir(join(directory, "lib"));
      await writeFile(join(directory, "package.json"), '{"name":"fixture"}');
      await writeFile(join(directory, "src", "index.ts"), "export {};\n");
      await writeFile(join(directory, "lib", "owned.js"), "tracked source");
      await writeFile(
        join(directory, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { outDir: "lib" }, files: ["src/index.ts"] }),
      );
      await trackAll(directory);
      const workspace = {
        name: "fixture",
        directory,
        manifest: { name: "fixture" },
        localDependencies: [],
      };
      await expect(packageBuildOutputs(workspace)).rejects.toThrow("contains tracked files");
      await writeFile(
        join(directory, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { outDir: "../outside" }, files: ["src/index.ts"] }),
      );
      await expect(packageBuildOutputs(workspace)).rejects.toThrow("unsafe build output");
      expect(await Bun.file(join(directory, "lib", "owned.js")).text()).toBe("tracked source");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("sanitizes devDependencies from cached bundled package manifests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "integration-bundled-manifest-"));
    try {
      const packageDirectory = join(directory, "node_modules", "@fixture", "local");
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

      const manifest = await readManifest(join(packageDirectory, "package.json"));
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
    ).toEqual(["bin/cli.d.ts", "bin/cli.js.map", "src/index.d.ts", "stray.txt"]);
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
    const directory = await mkdtemp(join(tmpdir(), "integration-repeat-stage-"));
    const output = await mkdtemp(join(tmpdir(), "integration-repeat-output-"));
    try {
      await mkdir(join(directory, "src"));
      await writeFile(join(directory, "src", "index.js"), "export const value = 1;\n");
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
    expect(resolveExportSubpath(exports, "./AWS/S3")).toBe("./src/AWS/S3/index.ts");
    expect(resolveExportSubpath(exports, "./AWS/Lambda/Durable")).toBe(
      "./src/AWS/Lambda/Durable.ts",
    );
    expect(resolveExportSubpath(exports, "./AWS/Endpoint")).toBe("./src/AWS/Endpoint.ts");
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
    expect(() => assertConsumerSubpaths(entries, manifest, ["alchemy/AWS/S3"])).not.toThrow();
    expect(() => assertConsumerSubpaths(entries, manifest, ["alchemy/AWS/Endpoint"])).toThrow(
      "resolves to missing packaged file",
    );
    expect(() => assertConsumerSubpaths(entries, manifest, ["alchemy/Output"])).toThrow(
      "is not exported",
    );
  });

  test("rejects a bundled package that is not the local build", () => {
    const local = ["package/package.json", "package/src/api.ts", "package/src/xml.ts"];
    const bundled = new Set([
      "package/node_modules/@distilled.cloud/core/package.json",
      "package/node_modules/@distilled.cloud/core/src/api.ts",
    ]);
    expect(() => assertBundledFiles(bundled, "@distilled.cloud/core", local)).toThrow(
      "not the local build",
    );
    bundled.add("package/node_modules/@distilled.cloud/core/src/xml.ts");
    expect(() => assertBundledFiles(bundled, "@distilled.cloud/core", local)).not.toThrow();
  });

  test("every Samva subpath is published from existing source", async () => {
    const directory = resolve(repositoryRoot, "packages/alchemy");
    const manifest = await readManifest(resolve(directory, "package.json"));
    const published = (manifest.publishConfig as { exports: unknown }).exports;
    for (const specifier of consumerSubpaths) {
      const subpath = specifier === "alchemy" ? "." : `./${specifier.slice("alchemy/".length)}`;
      const resolved = resolveExportSubpath(published, subpath) as
        | Record<string, string>
        | undefined;
      expect(resolved, specifier).toBeDefined();
      expect(await Bun.file(resolve(directory, resolved!.bun!)).exists(), specifier).toBe(true);
    }
  });

  test("installs the workspace's exact Effect version beside the artifact", async () => {
    expect(await workspaceEffectVersion(repositoryRoot)).toBe("4.0.4");
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
