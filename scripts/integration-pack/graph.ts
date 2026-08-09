import { join, resolve } from "node:path";

import { readManifest } from "./io.ts";
import type { PackageManifest, WorkspacePackage } from "./types.ts";

const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const workspaceDependencyNames = (
  manifest: PackageManifest,
  catalogLocalDependencies: ReadonlySet<string>,
): ReadonlyArray<string> =>
  dependencySections.flatMap((section) =>
    Object.entries(manifest[section] ?? {})
      .filter(
        ([name, specifier]) =>
          specifier.startsWith("workspace:") ||
          (specifier.startsWith("catalog:") &&
            catalogLocalDependencies.has(name)),
      )
      .map(([name]) => name),
  );

const localCatalogDependencyNames = (
  root: PackageManifest,
): ReadonlySet<string> => {
  const workspaces = root.workspaces;
  if (typeof workspaces !== "object" || workspaces === null) return new Set();
  const names = new Set<string>();
  const collect = (catalog: unknown): void => {
    if (typeof catalog !== "object" || catalog === null) return;
    for (const [name, specifier] of Object.entries(catalog)) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:"))
        names.add(name);
    }
  };
  collect("catalog" in workspaces ? workspaces.catalog : undefined);
  if (
    "catalogs" in workspaces &&
    typeof workspaces.catalogs === "object" &&
    workspaces.catalogs !== null
  ) {
    for (const catalog of Object.values(workspaces.catalogs)) collect(catalog);
  }
  return names;
};

const workspaceManifests = async (
  repositoryRoot: string,
): Promise<{
  readonly manifests: ReadonlyMap<string, string>;
  readonly catalogLocalDependencies: ReadonlySet<string>;
}> => {
  const rootManifest = await readManifest(join(repositoryRoot, "package.json"));
  const workspaces = rootManifest.workspaces;
  if (
    typeof workspaces !== "object" ||
    workspaces === null ||
    !("packages" in workspaces) ||
    !Array.isArray(workspaces.packages)
  ) {
    throw new Error("Root package.json has no workspaces.packages array");
  }

  const manifests = new Map<string, string>();
  for (const pattern of workspaces.packages) {
    if (typeof pattern !== "string") continue;
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for await (const path of glob.scan({ cwd: repositoryRoot })) {
      const manifest = await readManifest(join(repositoryRoot, path));
      if (typeof manifest.name === "string")
        manifests.set(manifest.name, join(repositoryRoot, path));
    }
  }
  return {
    manifests,
    catalogLocalDependencies: localCatalogDependencyNames(rootManifest),
  };
};

/** Returns dependencies before the packages that consume them. */
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
