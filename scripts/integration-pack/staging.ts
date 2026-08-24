import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";

import { onlyTarball, packageSlug, readManifest, run } from "./io.ts";
import { nativePack, pnpmInstallCommand, pnpmPackCommand } from "./pack.ts";
import type {
  PackageManifest,
  PackedPackage,
  WorkspacePackage,
} from "./types.ts";

const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const knownMissingExports: Readonly<Record<string, ReadonlyArray<string>>> = {
  alchemy: [
    "./Construct",
    "./ContentType",
    "./Cli/InkCLI",
    "./Cloudflare/Live",
    "./Endpoint",
    "./Process",
    "./TUI",
  ],
  // Distilled dd2a32258180 no longer has src/index.ts, but its core package
  // still declares a root export. Consumers use the supported subpaths.
  "@distilled.cloud/core": ["."],
};

export const assertPublishableManifest = (
  name: string,
  manifest: PackageManifest,
): void => {
  for (const section of dependencySections) {
    for (const [dependency, specifier] of Object.entries(
      manifest[section] ?? {},
    )) {
      if (
        specifier.startsWith("workspace:") ||
        specifier.startsWith("catalog:") ||
        specifier.startsWith("file:")
      ) {
        throw new Error(
          `${name} has unresolved ${section}.${dependency}: ${specifier}`,
        );
      }
    }
  }
};

const exportTargets = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(exportTargets);
};

const exportTargetPattern = (target: string): RegExp =>
  new RegExp(
    `^${target
      .slice(2)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", "[^/]+")}$`,
  );

const filesUnder = async (
  root: string,
  directory: string,
): Promise<ReadonlyArray<string>> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (entry.isFile())
      files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files;
};

const exportTargetExists = async (
  directory: string,
  target: string,
): Promise<boolean> => {
  if (!target.startsWith("./")) return true;
  if (target.includes("*")) {
    try {
      return (await filesUnder(directory, directory)).some((path) =>
        exportTargetPattern(target).test(path),
      );
    } catch {
      return false;
    }
  }
  try {
    const targetStat = await stat(join(directory, target));
    if (!targetStat.isFile()) return false;
    return true;
  } catch {
    return false;
  }
};

export const assertSafeArchiveEntries = (
  entries: ReadonlyArray<string>,
): void => {
  for (const entry of entries) {
    if (entry.length === 0) continue;
    const withoutTrailingSlash = entry.endsWith("/")
      ? entry.slice(0, -1)
      : entry;
    if (
      posix.isAbsolute(entry) ||
      entry.includes("\\") ||
      withoutTrailingSlash.split("/").includes("..") ||
      posix.normalize(withoutTrailingSlash) !== withoutTrailingSlash
    ) {
      throw new Error(`Archive contains unsafe path ${entry}`);
    }
  }
};

export const patchIntegrationManifest = async (
  directory: string,
  manifest: PackageManifest,
): Promise<PackageManifest> => {
  const patched = structuredClone(manifest);
  const exports = patched.exports;
  if (typeof exports !== "object" || exports === null || Array.isArray(exports))
    return patched;

  for (const subpath of knownMissingExports[patched.name ?? ""] ?? []) {
    const value = (exports as Record<string, unknown>)[subpath];
    if (value === undefined) continue;
    const targets = exportTargets(value);
    const exists = await Promise.all(
      targets.map((target) => exportTargetExists(directory, target)),
    );
    if (exists.every(Boolean)) continue;
    delete (exports as Record<string, unknown>)[subpath];
  }
  return patched;
};

export const assertExportTargets = async (
  name: string,
  directory: string,
  manifest: PackageManifest,
): Promise<void> => {
  for (const target of exportTargets(manifest.exports)) {
    if (!(await exportTargetExists(directory, target)))
      throw new Error(`${name} declares missing runtime export ${target}`);
  }
};

const writeManifest = async (
  directory: string,
  manifest: PackageManifest,
): Promise<void> =>
  writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

/** Keep only local packages that the final artifact explicitly bundles. */
const keepOnlyBundledPackages = async (
  directory: string,
  bundled: ReadonlyArray<PackedPackage>,
): Promise<void> => {
  if (bundled.length === 0) return;
  const expected = new Map<string, Set<string>>();
  for (const packed of bundled) {
    const [scope, name] = packed.name.split("/");
    if (name === undefined) {
      expected.set(scope!, new Set());
    } else {
      const scoped = expected.get(scope!) ?? new Set<string>();
      scoped.add(name);
      expected.set(scope!, scoped);
    }
  }

  const nodeModules = join(directory, "node_modules");
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    const names = expected.get(entry.name);
    const path = join(nodeModules, entry.name);
    if (names === undefined) {
      await rm(path, { recursive: true, force: true });
    } else if (names.size > 0) {
      for (const nested of await readdir(path, { withFileTypes: true })) {
        if (!names.has(nested.name))
          await rm(join(path, nested.name), { recursive: true, force: true });
      }
    }
  }
};

const promoteBundledRuntimeDependencies = async (
  directory: string,
  manifest: PackageManifest,
  bundled: ReadonlyArray<PackedPackage>,
): Promise<void> => {
  const localNames = new Set(bundled.map((packed) => packed.name));
  for (const packed of bundled) {
    const bundledManifest = await readManifest(
      join(directory, "node_modules", packed.name, "package.json"),
    );
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      const optional = section === "optionalDependencies";
      for (const [name, specifier] of Object.entries(
        bundledManifest[section] ?? {},
      )) {
        if (localNames.has(name)) continue;
        const existing =
          manifest.dependencies?.[name] ??
          manifest.optionalDependencies?.[name];
        if (existing !== undefined || optional) {
          manifest.optionalDependencies ??= {};
          manifest.optionalDependencies[name] = existing ?? specifier;
        } else {
          manifest.dependencies ??= {};
          manifest.dependencies[name] = specifier;
        }
      }
    }
  }
};

/** Remove local edges and nested installs from bundled workspace packages. */
const makeBundledPackagesSelfContained = async (
  directory: string,
  bundled: ReadonlyArray<PackedPackage>,
): Promise<void> => {
  const localNames = new Set(bundled.map((packed) => packed.name));
  for (const packed of bundled) {
    const packageDirectory = join(directory, "node_modules", packed.name);
    const manifest = await readManifest(join(packageDirectory, "package.json"));
    for (const section of dependencySections) {
      for (const name of localNames) delete manifest[section]?.[name];
    }
    await writeManifest(packageDirectory, manifest);
    await rm(join(packageDirectory, "node_modules"), {
      recursive: true,
      force: true,
    });
  }
};

interface StagePackageInput {
  readonly repositoryRoot: string;
  readonly workspace: WorkspacePackage;
  readonly localPackages: ReadonlyArray<PackedPackage>;
  readonly version: string;
  readonly outputDir: string;
  readonly bundleLocalPackages: boolean;
}

/** Rewrite only a disposable native archive, then repack it with pnpm. */
export const stageAndPack = async (
  input: StagePackageInput,
): Promise<string> => {
  const temporary = await mkdtemp(join(tmpdir(), "alchemy-integration-stage-"));
  try {
    const rawTarball = await nativePack(
      input.workspace,
      join(temporary, "native"),
    );
    const unpacked = join(temporary, "unpacked");
    await mkdir(unpacked);
    const entries = (
      await run(["tar", "-tzf", rawTarball], {
        cwd: input.repositoryRoot,
        quiet: true,
      })
    ).split("\n");
    assertSafeArchiveEntries(entries);
    const verbose = await run(["tar", "-tvzf", rawTarball], {
      cwd: input.repositoryRoot,
      quiet: true,
    });
    if (verbose.split("\n").some((entry) => /^[lh]/.test(entry))) {
      throw new Error("Archive contains unsupported symbolic or hard links");
    }
    await run(["tar", "-xzf", rawTarball, "-C", unpacked], {
      cwd: input.repositoryRoot,
    });
    const directory = join(unpacked, "package");
    const rawManifest = await patchIntegrationManifest(
      directory,
      await readManifest(join(directory, "package.json")),
    );
    const directLocalDependencies = new Set(input.workspace.localDependencies);
    const localPackages = new Map(
      input.localPackages.map((packed) => [packed.name, packed]),
    );
    const installationLocals = [...localPackages.keys()];
    const bundled = input.bundleLocalPackages ? input.localPackages : [];

    const installManifest = structuredClone(rawManifest);
    installManifest.version = input.version;
    delete installManifest.devDependencies;
    installManifest.dependencies ??= {};
    installManifest.overrides = {};
    for (const name of installationLocals) {
      const packed = localPackages.get(name);
      if (packed === undefined)
        throw new Error(
          `${input.workspace.name} needs unpacked local dependency ${name}`,
        );
      installManifest.dependencies[name] = `file:${packed.tarball}`;
      installManifest.overrides[name] = `file:${packed.tarball}`;
    }
    for (const name of directLocalDependencies) {
      const packed = localPackages.get(name);
      if (packed === undefined)
        throw new Error(
          `${input.workspace.name} needs unpacked local dependency ${name}`,
        );
      for (const section of dependencySections) {
        if (rawManifest[section]?.[name] !== undefined) {
          installManifest[section] ??= {};
          installManifest[section]![name] = `file:${packed.tarball}`;
        }
      }
    }
    await writeManifest(directory, installManifest);
    await run(pnpmInstallCommand(), { cwd: directory });

    const publishManifest = structuredClone(installManifest);
    delete publishManifest.overrides;
    for (const name of installationLocals) {
      const dependencies = publishManifest.dependencies!;
      if (directLocalDependencies.has(name)) {
        for (const section of dependencySections) {
          if (rawManifest[section]?.[name] !== undefined) {
            publishManifest[section] ??= {};
            publishManifest[section]![name] = localPackages.get(name)!.version;
          }
        }
        if (rawManifest.dependencies?.[name] === undefined)
          delete dependencies[name];
      } else {
        delete dependencies[name];
      }
    }
    if (bundled.length > 0)
      publishManifest.bundledDependencies = bundled.map(
        (packed) => packed.name,
      );
    for (const packed of bundled) {
      delete publishManifest.dependencies?.[packed.name];
      delete publishManifest.optionalDependencies?.[packed.name];
      delete publishManifest.peerDependencies?.[packed.name];
    }
    await promoteBundledRuntimeDependencies(
      directory,
      publishManifest,
      bundled,
    );
    await makeBundledPackagesSelfContained(directory, bundled);
    assertPublishableManifest(input.workspace.name, publishManifest);
    await assertExportTargets(input.workspace.name, directory, publishManifest);
    await writeManifest(directory, publishManifest);
    await keepOnlyBundledPackages(directory, bundled);

    const destination = join(temporary, "out");
    await mkdir(destination);
    await run(pnpmPackCommand(destination), { cwd: directory });
    const produced = await onlyTarball(destination);
    const finalTarball = join(
      input.outputDir,
      `${packageSlug(input.workspace.name)}-${input.version}.tgz`,
    );
    await mkdir(input.outputDir, { recursive: true });
    await cp(produced, finalTarball);
    return finalTarball;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
