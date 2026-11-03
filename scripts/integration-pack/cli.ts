import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { withCleanBuildOutputs } from "./build.ts";
import { loadCachedPackage, saveCachedPackage } from "./cache.ts";
import { assertBuildInputsUnchanged, snapshotBuildInputs } from "./fingerprint.ts";
import { integrationClosure, workspaceEffectVersion } from "./graph.ts";
import { packageSlug, run, versionBase } from "./io.ts";
import { assertRepositoryRuntimes, packageBuildScript, repositoryPnpmVersion } from "./pack.ts";
import { stageCollectionPackage } from "./staging.ts";
import type { IntegrationPackOptions, PackedPackage } from "./types.ts";
import { sha256, verifyPackageArchive, verifyFreshConsumer } from "./verify.ts";

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
  if (requestedVerify !== undefined && !["none", "archive", "consumer"].includes(requestedVerify)) {
    throw new Error(`--verify must be none, archive, or consumer; received ${requestedVerify}`);
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

const packageVersion = (version: string, commit: string, fingerprint: string): string =>
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
  const inputsBefore = await snapshotBuildInputs(repositoryRoot, workspaces, commit);
  const fingerprints = inputsBefore.fingerprints;
  const cached = new Map<string, PackedPackage | undefined>();
  for (const workspace of workspaces) {
    cached.set(
      workspace.name,
      await loadCachedPackage(options.cacheDir, fingerprints.get(workspace.name)!),
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

  const runtimes = await assertRepositoryRuntimes(repositoryRoot);
  await mkdir(options.cacheDir, { recursive: true });
  const pnpmVersion = await repositoryPnpmVersion(repositoryRoot);
  console.log(`Runtimes bun=${runtimes.bun} node=${runtimes.node} pnpm=${pnpmVersion}`);
  const packed = new Map<string, PackedPackage>();
  const planned = workspaces.map((workspace) => {
    const fingerprint = fingerprints.get(workspace.name)!;
    return {
      name: workspace.name,
      fingerprint,
      version: packageVersion(workspace.manifest.version ?? "0.0.0", commit, fingerprint),
      tarball: "",
    };
  });
  const packWorkspace = async (
    workspace: (typeof workspaces)[number],
    alreadyBuilt = false,
  ): Promise<void> => {
    const fingerprint = fingerprints.get(workspace.name)!;
    const cacheHit = !options.force ? cached.get(workspace.name) : undefined;
    if (cacheHit !== undefined) {
      packed.set(workspace.name, cacheHit);
      console.log(`Reused ${workspace.name}@${cacheHit.version}`);
      return;
    }

    const buildScript = packageBuildScript(workspace.manifest);
    const buildAndPack = async (): Promise<PackedPackage> => {
      if (buildScript !== undefined && !alreadyBuilt) {
        await run(["pnpm", "run", buildScript], { cwd: workspace.directory });
        await assertBuildInputsUnchanged(repositoryRoot, workspaces, commit, inputsBefore);
        console.log(`Built ${workspace.name}`);
      }
      const version = planned.find((candidate) => candidate.name === workspace.name)!.version;
      const tarball = await stageCollectionPackage({
        repositoryRoot,
        pnpmVersion,
        workspace,
        localPackages: planned,
        version,
        outputDir: join(options.cacheDir, "tarballs", fingerprint),
      });
      await assertBuildInputsUnchanged(repositoryRoot, workspaces, commit, inputsBefore);
      if (options.verify !== "none") await verifyPackageArchive(tarball);
      const result = { name: workspace.name, version, tarball, fingerprint };
      await saveCachedPackage(options.cacheDir, result);
      return result;
    };
    const result =
      buildScript === undefined || alreadyBuilt
        ? await buildAndPack()
        : await withCleanBuildOutputs(workspace, buildAndPack);
    packed.set(workspace.name, result);
    console.log(`Packed ${workspace.name}@${result.version}`);
  };

  const distilled = workspaces.filter((workspace) =>
    workspace.name.startsWith("@distilled.cloud/"),
  );
  const needsDistilledBuild =
    options.force || distilled.some((workspace) => cached.get(workspace.name) === undefined);
  if (needsDistilledBuild) {
    const root = join(repositoryRoot, "submodules/distilled");
    const selected = distilled.map((workspace) => relative(root, workspace.directory));
    const buildAndPackDistilled = async (): Promise<void> => {
      await run([join(repositoryRoot, "node_modules/.bin/tsrs"), "-b", ...selected], { cwd: root });
      await run(["node", "scripts/bundle-lib.ts", ...selected], { cwd: root });
      await run(["node", "scripts/strip-lib-docs.ts", ...selected], { cwd: root });
      await assertBuildInputsUnchanged(repositoryRoot, workspaces, commit, inputsBefore);
      for (const workspace of distilled) await packWorkspace(workspace, true);
    };
    // The root bundler always rewrites core. Quarantine the entire SDK unit
    // and finish compilation before any bundle/facade is emitted or packed.
    const clean = async (index: number): Promise<void> => {
      const workspace = distilled[index];
      if (workspace === undefined) return buildAndPackDistilled();
      await withCleanBuildOutputs(workspace, () => clean(index + 1));
    };
    await clean(0);
  } else {
    for (const workspace of distilled) await packWorkspace(workspace, true);
  }
  for (const workspace of workspaces.filter(
    (workspace) => !workspace.name.startsWith("@distilled.cloud/"),
  ))
    await packWorkspace(workspace);

  const alchemy = packed.get("alchemy");
  if (alchemy === undefined) throw new Error("Integration closure has no alchemy package");
  await mkdir(options.outputDir, { recursive: true });
  const artifacts: PackedPackage[] = [];
  for (const candidate of packed.values()) {
    const artifact = join(
      options.outputDir,
      `${packageSlug(candidate.name)}-${candidate.version}.tgz`,
    );
    await copyFile(candidate.tarball, artifact);
    if (options.verify !== "none") await verifyPackageArchive(artifact);
    artifacts.push({ ...candidate, tarball: artifact });
  }
  const entrypoint = artifacts.find((candidate) => candidate.name === "alchemy")!;
  if (options.verify === "consumer")
    await verifyFreshConsumer(entrypoint.tarball, {
      effect: await workspaceEffectVersion(repositoryRoot),
      packages: artifacts,
    });
  const receipt = {
    commit: (await Bun.$`git rev-parse HEAD`.text()).trim(),
    distilled: (await Bun.$`git -C submodules/distilled rev-parse HEAD`.text()).trim(),
    verify: options.verify,
    packages: await Promise.all(
      artifacts.map(async (artifact) => ({
        ...artifact,
        sha256: await sha256(artifact.tarball),
      })),
    ),
    dependencies: Object.fromEntries(
      artifacts.map((artifact) => [artifact.name, `file:${artifact.tarball}`]),
    ),
  };
  const receiptPath = join(options.outputDir, `integration-${commit}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Created ${entrypoint.tarball}`);
  console.log(`Version ${entrypoint.version}`);
  console.log(`SHA256 ${await sha256(entrypoint.tarball)}`);
  console.log(`Receipt ${receiptPath}`);
  console.log(`Consumer dependencies: ${JSON.stringify(receipt.dependencies)}`);
};

if (import.meta.main) await main();
