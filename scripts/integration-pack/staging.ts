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
import { join } from "node:path";

import { onlyTarball, packageSlug, readManifest, run } from "./io.ts";
import { nativePack } from "./pack.ts";
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

const catalog = async (repositoryRoot: string): Promise<unknown> => {
  const root = await readManifest(join(repositoryRoot, "package.json"));
  const workspaces = root.workspaces;
  if (
    typeof workspaces !== "object" ||
    workspaces === null ||
    !("catalog" in workspaces)
  ) {
    throw new Error(
      "Root workspace catalog is required for integration staging",
    );
  }
  return workspaces.catalog;
};

const assertPublishableManifest = (
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

const assertExportTargets = async (
  name: string,
  directory: string,
  manifest: PackageManifest,
): Promise<void> => {
  for (const target of exportTargets(manifest.exports)) {
    if (!target.startsWith("./")) continue;
    const targetPrefix = target.slice(0, target.indexOf("*"));
    const candidate = target.includes("*")
      ? targetPrefix.endsWith("/")
        ? targetPrefix.slice(0, -1)
        : targetPrefix.slice(0, targetPrefix.lastIndexOf("/"))
      : target;
    try {
      await stat(join(directory, candidate));
    } catch {
      throw new Error(`${name} declares missing runtime export ${target}`);
    }
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

/**
 * Bun installs the complete runtime graph so its resolver validates the
 * staged manifest. Its bundled-dependency packer otherwise recursively
 * carries external transitive dependencies too. Keep only explicitly bundled
 * local packages in the disposable tree; the root manifest declares external
 * dependencies for a consumer's normal install.
 */
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
        if (!names.has(nested.name)) {
          await rm(join(path, nested.name), { recursive: true, force: true });
        }
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

/**
 * A bundled package resolves sibling workspace packages from the artifact's
 * root node_modules. Leaving its standalone local dependency declarations in
 * place makes Bun install a second copy from the lockfile/registry beneath
 * that package, which can shadow the verified bundled package at runtime.
 */
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

/**
 * The only manifest rewriting happens inside a disposable staging directory.
 * Source manifests and the native package archives are never edited.
 */
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
    await run(["tar", "-xzf", rawTarball, "-C", unpacked], {
      cwd: input.repositoryRoot,
    });
    const directory = join(unpacked, "package");
    const rawManifest = await readManifest(join(directory, "package.json"));
    const directLocalDependencies = new Set(input.workspace.localDependencies);
    const localPackages = new Map(
      input.localPackages.map((packed) => [packed.name, packed]),
    );
    const installationLocals = [...localPackages.keys()];
    const bundled = input.bundleLocalPackages ? input.localPackages : [];

    const installManifest = structuredClone(rawManifest);
    installManifest.version = input.version;
    // Development-only workspace edges are neither part of a publishable
    // package nor needed to resolve its runtime graph.
    delete installManifest.devDependencies;
    installManifest.workspaces = {
      catalog: await catalog(input.repositoryRoot),
    };
    installManifest.dependencies ??= {};
    for (const name of installationLocals) {
      const packed = localPackages.get(name);
      if (packed === undefined)
        throw new Error(
          `${input.workspace.name} needs unpacked local dependency ${name}`,
        );
      installManifest.dependencies[name] = `file:${packed.tarball}`;
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
    // This is a publish graph: source-only dev tools such as alchemy-test must
    // not be resolved from the staging package or leaked into its archive.
    await run(
      [
        "bun",
        "install",
        "--production",
        "--ignore-scripts",
        "--backend=copyfile",
      ],
      { cwd: directory },
    );

    const publishManifest = structuredClone(installManifest);
    delete publishManifest.workspaces;
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
    // Bundled packages are physically present in the archive. Declaring them as
    // ordinary dependencies makes a fresh Bun consumer fetch their unpublished
    // integration versions from the registry instead of using that bundle.
    for (const packed of bundled) {
      delete publishManifest.dependencies?.[packed.name];
      delete publishManifest.optionalDependencies?.[packed.name];
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
    await run(
      [
        "bun",
        "pm",
        "pack",
        "--destination",
        destination,
        "--ignore-scripts",
        "--quiet",
      ],
      { cwd: directory },
    );
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
