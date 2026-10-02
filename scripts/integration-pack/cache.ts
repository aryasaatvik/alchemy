import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PackedPackage } from "./types.ts";

type CacheEntry = Omit<PackedPackage, "tarball"> & { readonly file: string };

const indexPath = (cacheDir: string): string => join(cacheDir, "index.json");

const readIndex = async (
  cacheDir: string,
): Promise<Readonly<Record<string, CacheEntry>>> => {
  try {
    return JSON.parse(await readFile(indexPath(cacheDir), "utf8")) as Record<
      string,
      CacheEntry
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
};

export const loadCachedPackage = async (
  cacheDir: string,
  fingerprint: string,
): Promise<PackedPackage | undefined> => {
  const entry = (await readIndex(cacheDir))[fingerprint];
  if (entry === undefined) return undefined;
  const tarball = join(cacheDir, entry.file);
  try {
    if ((await stat(tarball)).size === 0) return undefined;
  } catch {
    return undefined;
  }
  return { ...entry, tarball };
};

export const saveCachedPackage = async (
  cacheDir: string,
  packed: PackedPackage,
): Promise<void> => {
  await mkdir(cacheDir, { recursive: true });
  const index = { ...(await readIndex(cacheDir)) };
  index[packed.fingerprint] = {
    name: packed.name,
    version: packed.version,
    fingerprint: packed.fingerprint,
    file: packed.tarball.slice(cacheDir.length + 1),
  };
  await writeFile(indexPath(cacheDir), `${JSON.stringify(index, null, 2)}\n`);
};
