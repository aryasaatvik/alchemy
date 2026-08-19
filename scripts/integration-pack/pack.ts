import { mkdir } from "node:fs/promises";

import { onlyTarball, run } from "./io.ts";
import type { PackageManifest, WorkspacePackage } from "./types.ts";

const exportTargets = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(exportTargets);
};

export const pnpmPackCommand = (output: string): ReadonlyArray<string> => [
  "pnpm",
  "--config.ignore-scripts=true",
  "pack",
  "--pack-destination",
  output,
];

/** Verifies pnpm packed the workspace package, not a same-named lockfile entry. */
const verifyNativePack = async (
  workspace: WorkspacePackage,
  archive: string,
): Promise<void> => {
  const manifest = JSON.parse(
    await run(["tar", "-xOf", archive, "package/package.json"], {
      cwd: workspace.directory,
      quiet: true,
    }),
  ) as PackageManifest;
  if (manifest.name !== workspace.name) {
    throw new Error(
      `${workspace.name} native pack contains ${manifest.name ?? "an unnamed package"}`,
    );
  }
  const entries = new Set(
    (
      await run(["tar", "-tzf", archive], {
        cwd: workspace.directory,
        quiet: true,
      })
    ).split("\n"),
  );
  for (const target of exportTargets(workspace.manifest.exports)) {
    if (!target.startsWith("./")) continue;
    const archiveTarget = `package/${target.slice(2)}`;
    if (target.includes("*")) {
      const prefix = archiveTarget.slice(0, archiveTarget.indexOf("*"));
      if (![...entries].some((entry) => entry.startsWith(prefix))) {
        throw new Error(`${workspace.name} native pack omits export ${target}`);
      }
    } else if (!entries.has(archiveTarget)) {
      throw new Error(`${workspace.name} native pack omits export ${target}`);
    }
  }
};

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
