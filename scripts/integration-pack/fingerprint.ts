import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { WorkspacePackage } from "./types.ts";

const sourceRoots = ["src", "bin", "scripts", "patches"];
const packageBuildInputs = [
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
  let entries: Awaited<ReturnType<typeof readdir>>;
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
  hash.update("integration-pack-cache-v7\0");
  hash.update(`package:${workspace.name}\0`);
  if (versionSalt !== undefined) hash.update(`version:${versionSalt}\0`);
  hash.update(await readFile(join(workspace.directory, "package.json")));
  for (const root of sourceRoots)
    await updateTree(
      hash,
      workspace.directory,
      join(workspace.directory, root),
    );
  for (const path of packageBuildInputs) {
    try {
      hash.update(`package-input:${path}\0`);
      hash.update(await readFile(join(workspace.directory, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const path of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_LICENSES.md",
    "scripts/copy-package-files.ts",
  ]) {
    try {
      hash.update(`${path}\0`);
      hash.update(await readFile(join(repositoryRoot, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await updateTree(
    hash,
    repositoryRoot,
    join(repositoryRoot, "scripts", "integration-pack"),
  );
  for (const [name, fingerprint] of Object.entries(dependencyFingerprints).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    hash.update(`dependency:${name}:${fingerprint}\0`);
  }
  return hash.digest("hex").slice(0, 20);
};
