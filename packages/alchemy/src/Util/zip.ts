import * as Effect from "effect/Effect";
import type JSZip from "jszip";
import { createRequire } from "node:module";

export interface ZipFile {
  path: string;
  content: string | Uint8Array<ArrayBufferLike>;
  /**
   * Unix file mode to record in the archive entry (e.g. `0o755` to keep an
   * executable bit). Omit to use the archiver's default.
   */
  mode?: number;
}

const archiveDate = new Date("1980-01-01T00:00:00.000Z");

/**
 * Generate the archive bytes deterministically. Nested paths make JSZip
 * synthesize the intermediate folder entries, and those are stamped with
 * `new Date()` rather than the per-file date the entries were added with.
 * Left alone, two archives built from identical bytes seconds apart differ —
 * which reads downstream as a content change.
 */
const generateDeterministic = (
  zip: JSZip,
  compression: "DEFLATE" | "STORE" = "DEFLATE",
) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      for (const entry of Object.values(zip.files)) {
        entry.date = archiveDate;
      }
    });
    return yield* Effect.promise(() =>
      zip.generateAsync({
        type: "nodebuffer",
        compression,
        platform: "UNIX",
      }),
    );
  });

export type ZipCompression = "DEFLATE" | "STORE" | "NATIVE_FAST";

interface NativeZipArchive {
  on(event: "data", listener: (chunk: Uint8Array) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error" | "warning", listener: (error: Error) => void): this;
  append(
    source: string | Buffer,
    options: { readonly name: string; readonly date: Date },
  ): this;
  finalize(): Promise<void>;
}

type NativeZipFactory = (
  format: "zip",
  options: { readonly zlib: { readonly level: number } },
) => NativeZipArchive;

const loadNativeZipFactory = Effect.sync(
  () => createRequire(import.meta.url)("archiver") as NativeZipFactory,
);

const toNativeZipSource = (
  source: string | Uint8Array<ArrayBufferLike>,
): string | Buffer =>
  typeof source === "string"
    ? source
    : Buffer.from(source.buffer, source.byteOffset, source.byteLength);

export const zipCode = Effect.fn(function* (
  content: string | Uint8Array<ArrayBufferLike>,
  files?: ReadonlyArray<ZipFile>,
  compression: ZipCompression = "DEFLATE",
) {
  if (compression === "NATIVE_FAST") {
    return yield* zipCodeNativeFast(content, files);
  }
  // Create a zip buffer in memory
  const zip = new (yield* Effect.promise(() => import("jszip"))).default();
  zip.file("index.mjs", content, { date: archiveDate });
  for (const file of files ?? []) {
    zip.file(file.path, file.content, {
      date: archiveDate,
      unixPermissions: file.mode,
    });
  }

  return yield* generateDeterministic(zip, compression);
});

const zipCodeNativeFast = Effect.fn(function* (
  content: string | Uint8Array<ArrayBufferLike>,
  files?: ReadonlyArray<ZipFile>,
) {
  const nativeZip = yield* loadNativeZipFactory;
  return yield* Effect.promise(async () => {
    const archive = nativeZip("zip", { zlib: { level: 1 } });
    const chunks: Uint8Array[] = [];
    const complete = new Promise<void>((resolve, reject) => {
      archive.on("data", (chunk) => chunks.push(chunk));
      archive.on("end", resolve);
      archive.on("error", reject);
      archive.on("warning", reject);
    });
    const date = new Date("1980-01-01T00:00:00.000Z");
    archive.append(toNativeZipSource(content), { name: "index.mjs", date });
    for (const file of [...(files ?? [])].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      archive.append(toNativeZipSource(file.content), {
        name: file.path,
        date,
      });
    }
    await archive.finalize();
    await complete;
    return Buffer.concat(chunks);
  });
});

/**
 * Package `files` into a deterministic zip archive: entries are sorted by
 * path and stamped with a fixed timestamp so identical inputs always produce
 * identical bytes.
 */
export const zipFiles = Effect.fn(function* (files: ReadonlyArray<ZipFile>) {
  // Create a zip buffer in memory
  const zip = new (yield* Effect.promise(() => import("jszip"))).default();
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    zip.file(file.path, file.content, {
      date: archiveDate,
      unixPermissions: file.mode,
    });
  }

  return yield* generateDeterministic(zip);
});
