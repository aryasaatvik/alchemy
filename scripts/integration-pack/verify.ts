import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./io.ts";
import type { PackageManifest, PackedPackage } from "./types.ts";

const archiveEntries = async (archive: string): Promise<ReadonlySet<string>> =>
  new Set(
    (
      await run(["tar", "-tzf", archive], { cwd: process.cwd(), quiet: true })
    ).split("\n"),
  );

const packageManifests = async (
  archive: string,
  entries: ReadonlySet<string>,
): Promise<ReadonlyMap<string, PackageManifest>> => {
  const manifestEntries = [...entries].filter(
    (entry) =>
      entry === "package/package.json" ||
      /^package\/node_modules\/.+\/package\.json$/.test(entry),
  );
  const manifests = await Promise.all(
    manifestEntries.map(
      async (entry) =>
        [
          entry,
          JSON.parse(
            await run(["tar", "-xOf", archive, entry], {
              cwd: process.cwd(),
              quiet: true,
            }),
          ) as PackageManifest,
        ] as const,
    ),
  );
  return new Map(manifests);
};

const exportTargets = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(exportTargets);
};

const assertArchiveExportTargets = (
  entries: ReadonlySet<string>,
  packageDirectory: string,
  manifest: PackageManifest,
): void => {
  for (const target of exportTargets(manifest.exports)) {
    if (!target.startsWith("./")) continue;
    const archiveTarget = `${packageDirectory}/${target.slice(2)}`;
    if (target.includes("*")) {
      const prefix = archiveTarget.slice(0, archiveTarget.indexOf("*"));
      if (![...entries].some((entry) => entry.startsWith(prefix))) {
        throw new Error(
          `${manifest.name} exports missing packaged target ${target}`,
        );
      }
    } else if (!entries.has(archiveTarget)) {
      throw new Error(
        `${manifest.name} exports missing packaged target ${target}`,
      );
    }
  }
};

export const verifyArchive = async (
  archive: string,
  localPackages: ReadonlyArray<PackedPackage>,
): Promise<void> => {
  const entries = await archiveEntries(archive);
  const manifests = await packageManifests(archive, entries);
  for (const manifest of manifests.values()) {
    if (
      JSON.stringify(manifest).includes("workspace:") ||
      JSON.stringify(manifest).includes("catalog:")
    ) {
      throw new Error(
        "Archive contains an unresolved workspace or catalog manifest reference",
      );
    }
  }
  const rootManifest = manifests.get("package/package.json");
  if (rootManifest === undefined)
    throw new Error("Archive is missing package/package.json");
  assertArchiveExportTargets(entries, "package", rootManifest);
  for (const packed of localPackages) {
    const expected = `package/node_modules/${packed.name}/package.json`;
    if (!entries.has(expected))
      throw new Error(`Archive is missing bundled ${expected}`);
    const manifest = manifests.get(expected);
    if (manifest === undefined)
      throw new Error(`Archive is missing readable ${expected}`);
    assertArchiveExportTargets(
      entries,
      `package/node_modules/${packed.name}`,
      manifest,
    );
  }
  for (const entry of [
    "package/lib/index.js",
    "package/src/index.ts",
    "package/node_modules/@distilled.cloud/aws/lib/index.js",
    "package/node_modules/@distilled.cloud/cloudflare/lib/services/accounts.js",
    "package/node_modules/@distilled.cloud/otel-collector/lib/layer-collector-0.22.0/index.js",
    "package/node_modules/@alchemy.run/cloudflare-runtime/dist/vite/node/plugin.mjs",
  ]) {
    if (!entries.has(entry))
      throw new Error(`Archive is missing required runtime output ${entry}`);
  }
};

/** A fresh package-manager install exercises the exported Node and Bun surfaces. */
export const verifyFreshConsumer = async (artifact: string): Promise<void> => {
  const consumer = await mkdtemp(
    join(tmpdir(), "alchemy-integration-consumer-"),
  );
  try {
    await mkdir(consumer, { recursive: true });
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ private: true, type: "module", dependencies: { alchemy: `file:${artifact}` } }, null, 2)}\n`,
    );
    await writeFile(
      join(consumer, "consumer.ts"),
      `import * as AWS from "alchemy/AWS";
import * as Duration from "effect/Duration";
import { Vite } from "alchemy/Cloudflare/Website";
import { collector, Exporter, pipeline, Processor, Receiver } from "alchemy/AWS/Lambda";

export const website = Vite;
const emitted = collector({
  telemetry: { logs: { level: "warn" } },
  pipelines: {
    traces: pipeline({
      receivers: [Receiver.otlp({ protocols: { http: { endpoint: "127.0.0.1:4318" } } })],
      processors: [Processor.batch({ timeout: Duration.seconds(1) })],
      exporters: [Exporter.otlpHttp({ endpoint: "https://api.example.invalid" })],
    }),
  },
});
if (!AWS.Lambda || !emitted.content.includes("otlphttp")) throw new Error("packed runtime did not load");
`,
    );
    await writeFile(
      join(consumer, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { module: "preserve", moduleResolution: "bundler", noEmit: true, skipLibCheck: true, strict: true, target: "ESNext" }, include: ["consumer.ts"] }, null, 2)}\n`,
    );
    await writeFile(
      join(consumer, "consumer-node.mjs"),
      `await import("./node_modules/alchemy/node_modules/@distilled.cloud/aws/lib/services/s3.js");
console.log("compiled Distilled AWS S3 import passed");
`,
    );
    await run(["bun", "install", "--backend=copyfile"], { cwd: consumer });
    await run(
      [
        "bunx",
        "--package",
        "@typescript/native-preview",
        "tsgo",
        "-p",
        "tsconfig.json",
      ],
      { cwd: consumer },
    );
    await run(["bun", "consumer.ts"], { cwd: consumer });
    await run(["node", "consumer-node.mjs"], { cwd: consumer });
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
};

export const sha256 = async (path: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
};
