import { cp, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { onlyTarball, packageSlug, readManifest, run } from "./io.ts";
import { nativePack, pnpmPackCommand } from "./pack.ts";
import type { PackageManifest, PackedPackage, WorkspacePackage } from "./types.ts";

const dependencySections = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

export const assertPublishableManifest = (name: string, manifest: PackageManifest): void => {
  for (const section of dependencySections) {
    for (const [dependency, specifier] of Object.entries(manifest[section] ?? {})) {
      if (
        specifier.startsWith("workspace:") ||
        specifier.startsWith("catalog:") ||
        specifier.startsWith("file:")
      ) {
        throw new Error(`${name} has unresolved ${section}.${dependency}: ${specifier}`);
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

const filesUnder = async (root: string, directory: string): Promise<ReadonlyArray<string>> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files;
};

const exportTargetExists = async (directory: string, target: string): Promise<boolean> => {
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

export const assertSafeArchiveEntries = (entries: ReadonlyArray<string>): void => {
  for (const entry of entries) {
    if (entry.length === 0) continue;
    const withoutTrailingSlash = entry.endsWith("/") ? entry.slice(0, -1) : entry;
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

/**
 * Top-level files that `scripts/copy-package-files.ts` copies in at build
 * time, or that pnpm injects from the workspace root. They are untracked by
 * design and rewritten by every build.
 */
const packageMetadataFiles: ReadonlySet<string> = new Set([
  "LICENSE",
  "NOTICE",
  "README.md",
  "THIRD_PARTY_LICENSES.md",
]);

/**
 * Published files Git does not track and no build owns.
 *
 * A top-level directory without any tracked file (`lib/`, `dist/`) is a
 * build output root: the build owns everything under it. A directory with
 * tracked files (`bin/`, `src/`) is a source root, where an untracked file is
 * stale local output (e.g. declarations an old build emitted into `bin/`)
 * that `git reset --hard` keeps and the pack would ship.
 */
export const unownedPublishedFiles = (
  entries: ReadonlyArray<string>,
  tracked: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const sourceRoots = new Set(
    [...tracked].flatMap((path) => {
      const separator = path.indexOf("/");
      return separator === -1 ? [] : [path.slice(0, separator)];
    }),
  );
  return entries.filter((entry) => {
    if (tracked.has(entry)) return false;
    const separator = entry.indexOf("/");
    if (separator === -1) return !packageMetadataFiles.has(entry);
    return sourceRoots.has(entry.slice(0, separator));
  });
};

/** Refuses to stage a native pack that contains untracked source-root files. */
const assertPublishedFilesOwned = async (
  workspace: WorkspacePackage,
  archiveEntries: ReadonlyArray<string>,
): Promise<void> => {
  const tracked = new Set(
    (
      await run(["git", "ls-files", "-z"], {
        cwd: workspace.directory,
        quiet: true,
      })
    )
      .split("\0")
      .filter((path) => path.length > 0),
  );
  const files = archiveEntries
    .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/".length));
  const unowned = unownedPublishedFiles(files, tracked);
  if (unowned.length > 0)
    throw new Error(
      `${workspace.name} would publish files that Git does not track and no build produces; remove them and pack again:\n${unowned
        .map((path) => `  ${join(workspace.directory, path)}`)
        .join("\n")}`,
    );
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

const writeManifest = async (directory: string, manifest: PackageManifest): Promise<void> =>
  writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

interface StagePackageInput {
  readonly repositoryRoot: string;
  readonly pnpmVersion: string;
  readonly workspace: WorkspacePackage;
  readonly localPackages: ReadonlyArray<PackedPackage>;
  readonly version: string;
  readonly outputDir: string;
}

/** Publish separate provider artifacts without introducing provider edges into core. */
export const stageCollectionPackage = async (input: StagePackageInput): Promise<string> => {
  const temporary = await mkdtemp(join(tmpdir(), "alchemy-integration-package-"));
  try {
    const raw = await nativePack(input.workspace, input.pnpmVersion, join(temporary, "native"));
    const entries = (await run(["tar", "-tzf", raw], { cwd: temporary, quiet: true })).split("\n");
    assertSafeArchiveEntries(entries);
    await assertPublishedFilesOwned(input.workspace, entries);
    const verbose = await run(["tar", "-tvzf", raw], { cwd: temporary, quiet: true });
    if (verbose.split("\n").some((entry) => /^[lh]/.test(entry)))
      throw new Error("Archive contains unsupported symbolic or hard links");
    await run(["tar", "-xzf", raw, "-C", temporary], { cwd: temporary });
    const directory = join(temporary, "package");
    const manifest = await readManifest(join(directory, "package.json"));
    manifest.version = input.version;
    delete manifest.devDependencies;
    for (const section of dependencySections) {
      for (const packed of input.localPackages) {
        if (manifest[section]?.[packed.name] !== undefined)
          manifest[section]![packed.name] = packed.version;
      }
    }
    assertPublishableManifest(input.workspace.name, manifest);
    await assertExportTargets(input.workspace.name, directory, manifest);
    await writeManifest(directory, manifest);
    const output = join(temporary, "output");
    await mkdir(output);
    await run(pnpmPackCommand(input.pnpmVersion, output), { cwd: directory });
    const destination = join(
      input.outputDir,
      `${packageSlug(input.workspace.name)}-${input.version}.tgz`,
    );
    await mkdir(input.outputDir, { recursive: true });
    await cp(await onlyTarball(output), destination);
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
