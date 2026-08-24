import { mkdir } from "node:fs/promises";

import { onlyTarball, readManifest, run } from "./io.ts";
import type { WorkspacePackage } from "./types.ts";

export const pnpmPackCommand = (output: string): ReadonlyArray<string> => [
  "pnpm",
  "--config.ignore-scripts=true",
  "--config.node-linker=hoisted",
  "pack",
  "--pack-destination",
  output,
];

export const pnpmInstallCommand = (): ReadonlyArray<string> => [
  "pnpm",
  "--config.ignore-scripts=true",
  "--config.node-linker=hoisted",
  "install",
  "--prod",
];

/** Verifies pnpm packed the workspace package, not a same-named store entry. */
const verifyNativePack = async (
  workspace: WorkspacePackage,
  archive: string,
): Promise<void> => {
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
  output: string,
): Promise<string> => {
  await mkdir(output, { recursive: true });
  await run(pnpmPackCommand(output), { cwd: workspace.directory });
  const archive = await onlyTarball(output);
  await verifyNativePack(workspace, archive);
  return archive;
};
