import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { run } from "./io.ts";
import type { WorkspacePackage } from "./types.ts";

const sourceRoots = ["src", "bin", "scripts", "patches", "skills"];
const packageBuildInputs = [
  "README.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_LICENSES.md",
  ".npmignore",
  ".gitignore",
  "tsconfig.json",
  "tsconfig.bin.json",
  "tsconfig.build.json",
  "tsconfig.bundle.json",
  "tsconfig.node.json",
  "tsconfig.runtime.json",
  "tsdown.config.ts",
  "rolldown.config.ts",
  "bunfig.toml",
];

const updateTree = async (
  hash: ReturnType<typeof createHash>,
  root: string,
  directory: string,
): Promise<void> => {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    const label = relative(root, path);
    if (entry.isDirectory()) {
      hash.update(`directory:${label}\0`);
      await updateTree(hash, root, path);
    } else if (entry.isFile()) {
      hash.update(`file:${label}\0`);
      hash.update(await readFile(path));
    } else {
      const stats = await lstat(path);
      throw new Error(`Unsupported package input ${label} (${stats.mode})`);
    }
  }
};

export const packageFingerprint = async (
  repositoryRoot: string,
  workspace: WorkspacePackage,
  dependencyFingerprints: Readonly<Record<string, string>>,
  versionSalt?: string,
): Promise<string> => {
  const hash = createHash("sha256");
  hash.update("integration-pack-cache-v9\0");
  hash.update(`package:${workspace.name}\0`);
  if (versionSalt !== undefined) hash.update(`version:${versionSalt}\0`);
  hash.update(await readFile(join(workspace.directory, "package.json")));
  for (const root of sourceRoots)
    await updateTree(hash, workspace.directory, join(workspace.directory, root));
  for (const path of packageBuildInputs) {
    try {
      hash.update(`package-input:${path}\0`);
      hash.update(await readFile(join(workspace.directory, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const path of [
    ".gitignore",
    ".npmignore",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_LICENSES.md",
    "scripts/copy-package-files.ts",
    "scripts/package-build.ts",
    "scripts/typescript-source.ts",
    "tsconfig.base.json",
    "tsconfig.cloudflare.json",
    "submodules/distilled/tsconfig.base.json",
    "submodules/distilled/package.json",
    "submodules/distilled/pnpm-workspace.yaml",
    "submodules/distilled/pnpm-lock.yaml",
    "mise.toml",
  ]) {
    try {
      hash.update(`${path}\0`);
      hash.update(await readFile(join(repositoryRoot, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await updateTree(hash, repositoryRoot, join(repositoryRoot, "scripts", "integration-pack"));
  for (const [name, fingerprint] of Object.entries(dependencyFingerprints).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(`dependency:${name}:${fingerprint}\0`);
  }
  return hash.digest("hex").slice(0, 20);
};

export interface BuildInputs {
  readonly trackedDiff: string;
  readonly fingerprints: ReadonlyMap<string, string>;
}

/** Capture bytes, including already-dirty tracked files and untracked package inputs. */
export const snapshotBuildInputs = async (
  repositoryRoot: string,
  workspaces: ReadonlyArray<WorkspacePackage>,
  commit: string,
): Promise<BuildInputs> => {
  const fingerprints = new Map<string, string>();
  for (const workspace of workspaces) {
    const dependencies = Object.fromEntries(
      workspace.localDependencies.map((name) => {
        const fingerprint = fingerprints.get(name);
        if (fingerprint === undefined)
          throw new Error(`${workspace.name} has unordered dependency ${name}`);
        return [name, fingerprint];
      }),
    );
    fingerprints.set(
      workspace.name,
      await packageFingerprint(
        repositoryRoot,
        workspace,
        dependencies,
        workspace.name === "alchemy" ? commit : undefined,
      ),
    );
  }
  const repositories = new Set([repositoryRoot]);
  for (const workspace of workspaces) {
    let directory = workspace.directory;
    while (directory !== repositoryRoot && directory.startsWith(`${repositoryRoot}${sep}`)) {
      try {
        await lstat(join(directory, ".git"));
        repositories.add(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
  }
  let trackedDiff = "";
  for (const directory of [...repositories].sort()) {
    trackedDiff += `repository:${relative(repositoryRoot, directory)}\0`;
    trackedDiff += await run(
      [
        "git",
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=none",
        "HEAD",
      ],
      { cwd: directory, quiet: true },
    );
  }
  return { trackedDiff, fingerprints };
};

export const assertBuildInputsUnchanged = async (
  repositoryRoot: string,
  workspaces: ReadonlyArray<WorkspacePackage>,
  commit: string,
  before: BuildInputs,
): Promise<void> => {
  const after = await snapshotBuildInputs(repositoryRoot, workspaces, commit);
  const changed = workspaces
    .filter(
      (workspace) =>
        before.fingerprints.get(workspace.name) !== after.fingerprints.get(workspace.name),
    )
    .map((workspace) => workspace.name);
  if (before.trackedDiff !== after.trackedDiff || changed.length > 0) {
    throw new Error(
      `Build modified packaging inputs (${changed.join(", ") || "tracked files"}); commit the regenerated output and pack again`,
    );
  }
};
