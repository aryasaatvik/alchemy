import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadCachedPackage, saveCachedPackage } from "./cache.ts";
import { packageFingerprint } from "./fingerprint.ts";
import { integrationClosure } from "./graph.ts";
import { packageSlug, run, versionBase } from "./io.ts";
import { stageAndPack } from "./staging.ts";
import type { IntegrationPackOptions, PackedPackage } from "./types.ts";
import { sha256, verifyArchive, verifyFreshConsumer } from "./verify.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const defaultOutputDir = join(repositoryRoot, "artifacts");
const defaultCacheDir = join(defaultOutputDir, ".integration-pack-cache");

const optionValue = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
};

const parseOptions = (): IntegrationPackOptions => {
  const fast = Bun.argv.includes("--fast");
  const force = Bun.argv.includes("--force");
  const plan = Bun.argv.includes("--plan");
  const requestedVerify = optionValue("--verify");
  if (
    requestedVerify !== undefined &&
    !["none", "archive", "consumer"].includes(requestedVerify)
  ) {
    throw new Error(
      `--verify must be none, archive, or consumer; received ${requestedVerify}`,
    );
  }
  return {
    verify:
      (requestedVerify as IntegrationPackOptions["verify"] | undefined) ??
      (fast ? "archive" : "consumer"),
    force,
    plan,
    outputDir: resolve(optionValue("--output-dir") ?? defaultOutputDir),
    cacheDir: resolve(optionValue("--cache-dir") ?? defaultCacheDir),
  };
};

const packageVersion = (
  version: string,
  commit: string,
  fingerprint: string,
): string =>
  `${versionBase(version)}-samva.${commit}.${fingerprint.slice(0, 12)}`;

const logPlan = (
  options: IntegrationPackOptions,
  packages: ReadonlyArray<{
    readonly name: string;
    readonly fingerprint: string;
    readonly cached: boolean;
  }>,
): void => {
  console.log("Integration packaging plan");
  console.log(`verify=${options.verify} force=${options.force}`);
  console.log(`output=${options.outputDir}`);
  console.log(`cache=${options.cacheDir}`);
  for (const workspace of packages) {
    console.log(
      `${workspace.cached && !options.force ? "reuse" : "build+pack"} ${workspace.name} ${workspace.fingerprint}`,
    );
  }
};

export const main = async (): Promise<void> => {
  const options = parseOptions();
  const commit = (await Bun.$`git rev-parse --short=12 HEAD`.text()).trim();
  const workspaces = await integrationClosure(repositoryRoot);
  const fingerprints = new Map<string, string>();
  const cached = new Map<string, PackedPackage | undefined>();

  for (const workspace of workspaces) {
    const dependencies = Object.fromEntries(
      workspace.localDependencies.map((name) => {
        const fingerprint = fingerprints.get(name);
        if (fingerprint === undefined)
          throw new Error(`${workspace.name} has unordered dependency ${name}`);
        return [name, fingerprint];
      }),
    );
    const fingerprint = await packageFingerprint(
      repositoryRoot,
      workspace,
      dependencies,
      workspace.name === "alchemy" ? commit : undefined,
    );
    fingerprints.set(workspace.name, fingerprint);
    cached.set(
      workspace.name,
      await loadCachedPackage(options.cacheDir, fingerprint),
    );
  }

  if (options.plan) {
    logPlan(
      options,
      workspaces.map((workspace) => ({
        name: workspace.name,
        fingerprint: fingerprints.get(workspace.name)!,
        cached: cached.get(workspace.name) !== undefined,
      })),
    );
    return;
  }

  await mkdir(options.cacheDir, { recursive: true });
  const packed = new Map<string, PackedPackage>();
  for (const workspace of workspaces) {
    const fingerprint = fingerprints.get(workspace.name)!;
    const cacheHit = !options.force ? cached.get(workspace.name) : undefined;
    if (cacheHit !== undefined) {
      packed.set(workspace.name, cacheHit);
      console.log(`Reused ${workspace.name}@${cacheHit.version}`);
      continue;
    }

    if (workspace.manifest.scripts?.build !== undefined) {
      await run(["pnpm", "run", "build"], { cwd: workspace.directory });
      console.log(`Built ${workspace.name}`);
    }
    const isEntrypoint = workspace.name === "alchemy";
    const version = isEntrypoint
      ? packageVersion(
          workspace.manifest.version ?? "0.0.0",
          commit,
          fingerprint,
        )
      : (workspace.manifest.version ?? "0.0.0");
    const tarball = await stageAndPack({
      repositoryRoot,
      workspace,
      localPackages: [...packed.values()],
      version,
      outputDir: join(options.cacheDir, "tarballs", fingerprint),
      bundleLocalPackages: isEntrypoint,
    });
    const result = { name: workspace.name, version, tarball, fingerprint };
    await saveCachedPackage(options.cacheDir, result);
    packed.set(workspace.name, result);
    console.log(`Packed ${workspace.name}@${version}`);
  }

  const alchemy = packed.get("alchemy");
  if (alchemy === undefined)
    throw new Error("Integration closure has no alchemy package");
  const artifact = join(
    options.outputDir,
    `${packageSlug(alchemy.name)}-${alchemy.version}.tgz`,
  );
  await mkdir(options.outputDir, { recursive: true });
  await copyFile(alchemy.tarball, artifact);
  const localDependencies = [...packed.values()].filter(
    (packedPackage) => packedPackage.name !== "alchemy",
  );
  if (options.verify !== "none")
    await verifyArchive(artifact, localDependencies);
  if (options.verify === "consumer") await verifyFreshConsumer(artifact);

  console.log(`Created ${artifact}`);
  console.log(`Version ${alchemy.version}`);
  console.log(`SHA256 ${await sha256(artifact)}`);
  console.log(`Consumer dependency: "alchemy": "file:${artifact}"`);
};

await main();
