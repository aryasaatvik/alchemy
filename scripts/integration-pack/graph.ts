import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readManifest } from "./io.ts";
import type { PackageManifest, WorkspacePackage } from "./types.ts";

const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

interface PnpmWorkspace {
  readonly packages?: ReadonlyArray<string>;
  readonly catalog?: Readonly<Record<string, string>>;
  readonly catalogs?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

const readPnpmWorkspace = async (
  repositoryRoot: string,
): Promise<PnpmWorkspace> =>
  Bun.YAML.parse(
    await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8"),
  ) as PnpmWorkspace;

const localCatalogDependencyNames = (
  workspace: PnpmWorkspace,
): ReadonlySet<string> => {
  const names = new Set<string>();
  const collect = (catalog: unknown): void => {
    if (typeof catalog !== "object" || catalog === null) return;
    for (const [name, specifier] of Object.entries(catalog)) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:"))
        names.add(name);
    }
  };
  collect(workspace.catalog);
  for (const catalog of Object.values(workspace.catalogs ?? {}))
    collect(catalog);
  return names;
};

const workspaceDependencyNames = (
  manifest: PackageManifest,
  catalogLocalDependencies: ReadonlySet<string>,
): ReadonlyArray<string> => [
  ...new Set(
    dependencySections.flatMap((section) =>
      Object.entries(manifest[section] ?? {})
        .filter(
          ([name, specifier]) =>
            specifier.startsWith("workspace:") ||
            (specifier.startsWith("catalog:") &&
              catalogLocalDependencies.has(name)),
        )
        .map(([name]) => name),
    ),
  ),
];

const workspaceManifests = async (
  repositoryRoot: string,
): Promise<{
  readonly manifests: ReadonlyMap<string, string>;
  readonly catalogLocalDependencies: ReadonlySet<string>;
}> => {
  const workspace = await readPnpmWorkspace(repositoryRoot);
  if (!Array.isArray(workspace.packages))
    throw new Error("pnpm-workspace.yaml has no packages array");

  const manifests = new Map<string, string>();
  for (const pattern of workspace.packages) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for await (const path of glob.scan({ cwd: repositoryRoot })) {
      const manifestPath = join(repositoryRoot, path);
      const manifest = await readManifest(manifestPath);
      if (typeof manifest.name !== "string") continue;
      const existing = manifests.get(manifest.name);
      if (existing !== undefined && existing !== manifestPath) {
        throw new Error(
          `Duplicate workspace package ${manifest.name}: ${existing} and ${manifestPath}`,
        );
      }
      manifests.set(manifest.name, manifestPath);
    }
  }
  return {
    manifests,
    catalogLocalDependencies: localCatalogDependencyNames(workspace),
  };
};

/** Returns the complete publishable runtime closure in dependency order. */
export const integrationClosure = async (
  repositoryRoot: string,
  entrypoint = "alchemy",
): Promise<ReadonlyArray<WorkspacePackage>> => {
  const { manifests, catalogLocalDependencies } =
    await workspaceManifests(repositoryRoot);
  const ordered: WorkspacePackage[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = async (name: string): Promise<void> => {
    if (visited.has(name)) return;
    if (visiting.has(name))
      throw new Error(`Workspace dependency cycle includes ${name}`);
    const manifestPath = manifests.get(name);
    if (manifestPath === undefined)
      throw new Error(`Missing workspace package ${name}`);
    visiting.add(name);
    const manifest = await readManifest(manifestPath);
    if (manifest.private === true)
      throw new Error(`Integration closure includes private package ${name}`);
    const localDependencies = workspaceDependencyNames(
      manifest,
      catalogLocalDependencies,
    );
    for (const dependency of localDependencies) await visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push({
      name,
      directory: resolve(manifestPath, ".."),
      manifest,
      localDependencies,
    });
  };

  await visit(entrypoint);
  return ordered;
};
