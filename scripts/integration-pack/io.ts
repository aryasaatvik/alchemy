import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PackageManifest } from "./types.ts";

export const readManifest = async (path: string): Promise<PackageManifest> =>
  JSON.parse(await readFile(path, "utf8")) as PackageManifest;

export const run = async (
  command: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly quiet?: boolean },
): Promise<string> => {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const stdout = options.quiet ? await new Response(child.stdout).text() : "";
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
  }
  return stdout.trim();
};

export const packageSlug = (name: string): string =>
  name.replace(/^@/, "").replaceAll("/", "-");

export const versionBase = (version: string): string => {
  const base = /^\d+\.\d+\.\d+/.exec(version)?.[0];
  if (base === undefined)
    throw new Error(`Cannot derive a base version from ${version}`);
  return base;
};

export const onlyTarball = async (directory: string): Promise<string> => {
  const tarballs = (await readdir(directory)).filter((entry) =>
    entry.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one tarball in ${directory}, found ${tarballs.length}`,
    );
  }
  return join(directory, tarballs[0]!);
};
