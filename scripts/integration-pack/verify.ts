import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./io.ts";
import {
  assertPublishableManifest,
  assertSafeArchiveEntries,
} from "./staging.ts";
import type { PackageManifest, PackedPackage } from "./types.ts";

const archiveEntries = async (
  archive: string,
): Promise<ReadonlySet<string>> => {
  const entries = (
    await run(["tar", "-tzf", archive], { cwd: process.cwd(), quiet: true })
  ).split("\n");
  assertSafeArchiveEntries(entries);
  return new Set(entries);
};

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
      const pattern = new RegExp(
        `^${archiveTarget
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", "[^/]+")}$`,
      );
      if (![...entries].some((entry) => pattern.test(entry))) {
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

const requiredRuntimeOutputs = [
  "package/lib/index.js",
  "package/src/index.ts",
  "package/node_modules/@distilled.cloud/core/lib/api.js",
  "package/node_modules/@distilled.cloud/aws/lib/services/s3.js",
  "package/node_modules/@distilled.cloud/cloudflare/lib/services/accounts.js",
  "package/node_modules/@distilled.cloud/fly-io/lib/services/machines.js",
  "package/node_modules/@distilled.cloud/otel-collector/lib/index.js",
  "package/node_modules/@distilled.cloud/otel-collector/lib/duration.js",
  "package/node_modules/@distilled.cloud/otel-collector/lib/layer-collector-0.22.0/index.js",
  "package/node_modules/@alchemy.run/frontend-frameworks/dist/aws-lambda/index.js",
] as const;

export const verifyArchive = async (
  archive: string,
  localPackages: ReadonlyArray<PackedPackage>,
): Promise<void> => {
  const entries = await archiveEntries(archive);
  const manifests = await packageManifests(archive, entries);
  for (const manifest of manifests.values())
    assertPublishableManifest(manifest.name ?? "unnamed package", manifest);

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
    if (manifest.version !== packed.version) {
      throw new Error(
        `Archive bundled ${packed.name}@${manifest.version ?? "unknown"}, expected ${packed.version}`,
      );
    }
    assertArchiveExportTargets(
      entries,
      `package/node_modules/${packed.name}`,
      manifest,
    );
  }

  for (const entry of requiredRuntimeOutputs) {
    if (!entries.has(entry))
      throw new Error(`Archive is missing required runtime output ${entry}`);
  }
};

/** Install into a new Bun consumer and exercise source and compiled surfaces. */
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
import * as Cloudflare from "alchemy/Cloudflare";
import { CloudflareEnvironment } from "alchemy/Cloudflare/CloudflareEnvironment";
import * as Fly from "alchemy/Fly";

if (!AWS.Lambda || !Cloudflare.Worker || !Cloudflare.cloudflareViteFramework || !CloudflareEnvironment || !Fly.Machine) {
  throw new Error("packed Bun runtime surfaces did not load");
}
`,
    );
    await writeFile(
      join(consumer, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { module: "preserve", moduleResolution: "bundler", noEmit: true, skipLibCheck: true, strict: true, target: "ESNext" }, include: ["consumer.ts"] }, null, 2)}\n`,
    );
    await writeFile(
      join(consumer, "consumer-node.mjs"),
      `const [Alchemy, AWS, Cloudflare, CloudflareEnvironmentModule, Fly] = await Promise.all([
  import("alchemy"),
  import("alchemy/AWS"),
  import("alchemy/Cloudflare"),
  import("alchemy/Cloudflare/CloudflareEnvironment"),
  import("alchemy/Fly"),
]);
if (!Alchemy.Stack || !AWS.Lambda || !Cloudflare.Worker || !Cloudflare.cloudflareViteFramework || !CloudflareEnvironmentModule.CloudflareEnvironment || !Fly.Machine) {
  throw new Error("packed Node runtime surfaces did not load");
}
console.log("compiled Alchemy Node runtime imports passed");
`,
    );
    await run(["bun", "install", "--ignore-scripts", "--backend=copyfile"], {
      cwd: consumer,
    });
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
