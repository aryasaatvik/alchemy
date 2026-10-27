import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { onlyTarball, readManifest, run } from "./io.ts";
import type { PackageManifest, WorkspacePackage } from "./types.ts";

/**
 * The pnpm version the repository pins in `packageManager`. Staging runs in
 * temporary directories outside the repository, where pnpm would otherwise
 * run whatever version is installed globally.
 */
export const repositoryPnpmVersion = async (repositoryRoot: string): Promise<string> => {
  const packageManager = (await readManifest(join(repositoryRoot, "package.json"))).packageManager;
  const version =
    typeof packageManager === "string"
      ? /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager)?.[1]
      : undefined;
  if (version === undefined)
    throw new Error(
      `package.json must pin packageManager to an exact pnpm version; found ${String(packageManager)}`,
    );
  return version;
};

/**
 * Fails unless Bun and the `node` on PATH match the repository's
 * `devEngines.runtime`. Builds, staging and consumer checks run the runtimes
 * the outer command selected, so a mismatch would pack with another toolchain.
 */
export const assertRepositoryRuntimes = async (
  repositoryRoot: string,
): Promise<Readonly<Record<string, string>>> => {
  const runtimes =
    (await readManifest(join(repositoryRoot, "package.json"))).devEngines?.runtime ?? [];
  const node = await run(["node", "--version"], { cwd: repositoryRoot, quiet: true });
  const effective: Record<string, string> = { bun: Bun.version, node: node.replace(/^v/, "") };
  for (const { name, version } of runtimes) {
    const actual = effective[name];
    if (actual !== undefined && actual !== version && !actual.startsWith(`${version}.`))
      throw new Error(
        `Integration packing requires ${name} ${version} (devEngines.runtime); found ${actual}`,
      );
  }
  return effective;
};

export const pnpmPackCommand = (pnpmVersion: string, output: string): ReadonlyArray<string> => [
  "pnpm",
  "with",
  pnpmVersion,
  "--config.ignore-scripts=true",
  "--config.node-linker=hoisted",
  "pack",
  "--pack-destination",
  output,
];

export const pnpmInstallCommand = (pnpmVersion: string): ReadonlyArray<string> => [
  "pnpm",
  "with",
  pnpmVersion,
  "--config.ignore-scripts=true",
  "--config.node-linker=hoisted",
  "install",
  "--prod",
];

/** Verifies pnpm packed the workspace package, not a same-named store entry. */
const verifyNativePack = async (workspace: WorkspacePackage, archive: string): Promise<void> => {
  const manifest = await readManifestFromArchive(workspace.directory, archive);
  if (manifest.name !== workspace.name) {
    throw new Error(
      `${workspace.name} native pack contains ${manifest.name ?? "an unnamed package"}`,
    );
  }
};

const readManifestFromArchive = async (cwd: string, archive: string) =>
  JSON.parse(
    await run(["tar", "-xOf", archive, "package/package.json"], {
      cwd,
      quiet: true,
    }),
  ) as Awaited<ReturnType<typeof readManifest>>;

export const nativePack = async (
  workspace: WorkspacePackage,
  pnpmVersion: string,
  output: string,
): Promise<string> => {
  await mkdir(output, { recursive: true });
  await run(pnpmPackCommand(pnpmVersion, output), {
    cwd: workspace.directory,
  });
  const archive = await onlyTarball(output);
  await verifyNativePack(workspace, archive);
  return archive;
};

/** Build only this package; the integration closure already orders its dependencies. */
export const packageBuildScript = (manifest: PackageManifest): string | undefined =>
  manifest.scripts?.["build:package"] !== undefined
    ? "build:package"
    : manifest.scripts?.build !== undefined
      ? "build"
      : undefined;
