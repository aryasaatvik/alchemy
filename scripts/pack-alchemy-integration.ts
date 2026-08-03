#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

type Manifest = Record<string, unknown> & {
  name?: string;
  version?: string;
  exports?: unknown;
  scripts?: Record<string, string>;
  bundledDependencies?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type PackedWorkspace = {
  readonly name: string;
  readonly directory: string;
  readonly originalManifest: Manifest;
  readonly packedDirectory: string;
  readonly packedManifest: Manifest;
  readonly version: string;
  readonly artifact: string;
};

const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const runtimeDependencySections = [
  "dependencies",
  "optionalDependencies",
] as const;

const scriptsDir = import.meta.dir;
const repositoryRoot = resolve(scriptsDir, "..");
const alchemyPackageDir = join(repositoryRoot, "packages", "alchemy");

const argumentValue = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
};

const outputDir = resolve(
  argumentValue("--output-dir") ?? join(repositoryRoot, "artifacts"),
);
const skipBuild = Bun.argv.includes("--skip-build");

const readManifest = async (path: string): Promise<Manifest> =>
  JSON.parse(await readFile(path, "utf8")) as Manifest;

const run = async (
  command: string[],
  options: { cwd?: string; quiet?: boolean } = {},
): Promise<string> => {
  const process = Bun.spawn(command, {
    cwd: options.cwd ?? repositoryRoot,
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const stdout = options.quiet ? await new Response(process.stdout).text() : "";
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
  }
  return stdout.trim();
};

const hashTree = async (root: string): Promise<string> => {
  const hash = createHash("sha256");

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const path = join(directory, entry.name);
      const archivePath = relative(root, path);
      hash.update(
        `${entry.isDirectory() ? "directory" : "file"}:${archivePath}\0`,
      );
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        hash.update(await readFile(path));
      } else {
        const stats = await lstat(path);
        throw new Error(
          `Unsupported package entry ${archivePath} (${stats.mode})`,
        );
      }
    }
  };

  await visit(root);
  return hash.digest("hex").slice(0, 12);
};

const packageSlug = (name: string): string =>
  name.replace(/^@/, "").replaceAll("/", "-");

const versionBase = (version: string): string => {
  const base = /^\d+\.\d+\.\d+/.exec(version)?.[0];
  if (base === undefined) {
    throw new Error(`Cannot derive a base version from ${version}`);
  }
  return base;
};

const workspaceManifests = async (): Promise<Map<string, string>> => {
  const rootManifest = await readManifest(join(repositoryRoot, "package.json"));
  const workspaces = rootManifest.workspaces;
  if (
    typeof workspaces !== "object" ||
    workspaces === null ||
    !("packages" in workspaces) ||
    !Array.isArray(workspaces.packages)
  ) {
    throw new Error("Root package.json has no workspaces.packages array");
  }

  const manifests = new Map<string, string>();
  for (const workspacePattern of workspaces.packages) {
    if (typeof workspacePattern !== "string") continue;
    const glob = new Bun.Glob(`${workspacePattern}/package.json`);
    for await (const manifestPath of glob.scan({ cwd: repositoryRoot })) {
      const absolutePath = join(repositoryRoot, manifestPath);
      const manifest = await readManifest(absolutePath);
      if (typeof manifest.name === "string") {
        manifests.set(manifest.name, absolutePath);
      }
    }
  }
  return manifests;
};

const localDependencyNames = (manifest: Manifest): string[] => {
  const names: string[] = [];
  for (const section of dependencySections) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (specifier.startsWith("workspace:")) names.push(name);
    }
  }
  return names;
};

const runtimeExportTargets = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(runtimeExportTargets);
  if (typeof value !== "object" || value === null) return [];

  const conditions = value as Record<string, unknown>;
  for (const condition of ["bun", "import", "default", "node"]) {
    if (condition in conditions) {
      return runtimeExportTargets(conditions[condition]);
    }
  }
  return Object.entries(conditions).flatMap(([key, target]) =>
    key.startsWith(".") ? runtimeExportTargets(target) : [],
  );
};

const runtimeTargetExists = async (
  directory: string,
  target: unknown,
): Promise<boolean> => {
  if (typeof target === "string") {
    if (!target.startsWith("./")) return true;
    const prefix = target.slice(0, target.indexOf("*"));
    const candidate = target.includes("*")
      ? prefix.endsWith("/")
        ? prefix.slice(0, -1)
        : dirname(prefix)
      : target;
    try {
      await lstat(join(directory, candidate));
      return true;
    } catch {
      return false;
    }
  }
  if (Array.isArray(target)) {
    for (const candidate of target) {
      if (await runtimeTargetExists(directory, candidate)) return true;
    }
  }
  return false;
};

const pruneMissingSourceConditions = async (
  directory: string,
  value: unknown,
): Promise<void> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const exports = value as Record<string, unknown>;
  for (const condition of ["bun", "worker"]) {
    if (
      condition in exports &&
      !(await runtimeTargetExists(directory, exports[condition]))
    ) {
      delete exports[condition];
    }
  }
  for (const child of Object.values(exports)) {
    await pruneMissingSourceConditions(directory, child);
  }
};

const verifyRuntimeExports = async (
  name: string,
  directory: string,
  manifest: Manifest,
): Promise<void> => {
  for (const target of runtimeExportTargets(manifest.exports)) {
    if (!target.startsWith("./") || target.includes("*")) continue;
    try {
      await lstat(join(directory, target));
    } catch {
      throw new Error(
        `${name} runtime export ${target} is missing from the packed package; build the workspace before packing`,
      );
    }
  }
};

const verifyFreshConsumer = async (artifact: string): Promise<void> => {
  const consumer = join(temporaryDir, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: { alchemy: `file:${artifact}` },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumer, "entry.ts"),
    `import { Vite } from "alchemy/Cloudflare/Website";\nexport default Vite;\n`,
  );
  await writeFile(
    join(consumer, "provider-api.ts"),
    `import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export const providers = AWS.providers({
  serviceEndpoints: Effect.succeed({
    ses: "https://emulate.samva.localhost/ses",
  }),
  lambda: {
    local: {
      endpoint: Effect.succeed("http://floci:4566"),
      environment: Effect.succeed({
        REDIS_URL: "redis://redis:6379",
      }),
      serviceEndpoints: Effect.succeed({
        ses: "http://host.docker.internal:8811/ses",
      }),
    },
  },
});
`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "preserve",
          moduleResolution: "bundler",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ESNext",
        },
        include: ["provider-api.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumer, "acceptance.ts"),
    `import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Bundle from "alchemy/Bundle";
import {
  localEmulatorFunctionEnvironment,
  makeFunctionHttpHandler,
  resolveFunctionBundleConfig,
} from "alchemy/AWS/Lambda";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  CloudflareEnvironment,
  fromEnv,
} from "alchemy/Cloudflare/CloudflareEnvironment";
import { makeLocalWorkerStandardBindings } from "alchemy/Cloudflare/Workers";

const acceptance = Effect.gen(function* () {
  const config = yield* resolveFunctionBundleConfig({
    main: "entry.ts",
    isExternal: true,
  });
  const result = yield* Bundle.build(config.inputOptions, config.outputOptions);
  if (result.files.length === 0) {
    return yield* Effect.die("Lambda bundle produced no files");
  }
});

await Effect.runPromise(acceptance.pipe(Effect.provide(NodeServices.layer)));

const localEnvironment = await Effect.runPromise(
  localEmulatorFunctionEnvironment(
    { REDIS_URL: "redis://127.0.0.1:56379" },
    {
      endpoint: Effect.succeed("http://floci:4566"),
      environment: Effect.succeed({ REDIS_URL: "redis://redis:6379" }),
      serviceEndpoints: Effect.succeed({
        ses: "http://host.docker.internal:8811/ses",
      }),
    },
  ),
);
if (
  localEnvironment.REDIS_URL !== "redis://redis:6379" ||
  localEnvironment.AWS_ENDPOINT_URL !== "http://floci:4566" ||
  localEnvironment.ALCHEMY_AWS_SERVICE_ENDPOINTS !==
    JSON.stringify({ ses: "http://host.docker.internal:8811/ses" })
) {
  throw new Error("Local Lambda environment policy was not applied");
}

const httpHandler = makeFunctionHttpHandler(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    return HttpServerResponse.text(request.originalUrl);
  }),
);
const httpResult = await Effect.runPromise(
  httpHandler({
    version: "2.0",
    routeKey: "GET /health",
    rawPath: "/health",
    rawQueryString: "",
    headers: { host: "abc123.execute-api.us-west-2.amazonaws.com" },
    requestContext: {
      accountId: "100000000001",
      apiId: "abc123",
      domainName: "abc123.execute-api.us-west-2.amazonaws.com",
      domainPrefix: "abc123",
      http: {
        method: "GET",
        path: "/health",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "acceptance",
      },
      requestId: "request-id",
      routeKey: "GET /health",
      stage: "$default",
      time: "03/Aug/2026:00:00:00 +0000",
      timeEpoch: 1,
    },
    isBase64Encoded: false,
  }),
);
if (
  typeof httpResult === "string" ||
  httpResult.body !== "https://abc123.execute-api.us-west-2.amazonaws.com/health"
) {
  throw new Error("API Gateway v2 Lambda runtime request used an invalid scheme");
}

const accountId = "0123456789abcdef0123456789abcdef";
const localWorkerBinding = Effect.gen(function* () {
  const environment = yield* CloudflareEnvironment;
  const identity = yield* environment;
  if (Effect.isEffect(identity) || identity.accountId !== accountId) {
    return yield* Effect.die("Cloudflare environment did not resolve its identity");
  }
  const hooks = yield* makeLocalWorkerStandardBindings({
    accountId: identity.accountId,
    workerName: "acceptance-worker",
    stackName: "acceptance-stack",
    stage: "dev",
    env: { ALCHEMY_CLOUDFLARE_ACCOUNT_ID: undefined },
    descriptorNames: new Set(),
    selfUrl: undefined,
  });
  const bindings = yield* Effect.all(hooks);
  const accountBindings = bindings.filter(
    (binding) => binding.name === "ALCHEMY_CLOUDFLARE_ACCOUNT_ID",
  );
  if (
    accountBindings.length !== 1 ||
    !("text" in accountBindings[0]) ||
    accountBindings[0].text !== accountId
  ) {
    return yield* Effect.die("Local Worker account binding is not concrete");
  }
}).pipe(
  Effect.provide(fromEnv()),
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown({ CLOUDFLARE_ACCOUNT_ID: accountId }),
  ),
);

await Effect.runPromise(localWorkerBinding);
console.log("fresh-consumer Lambda bundle, runtime fixture, and local Worker binding passed");
`,
  );
  await run(["bun", "install"], { cwd: consumer });
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
  await run(["bun", "acceptance.ts"], { cwd: consumer });
};

const temporaryDir = await mkdtemp(join(tmpdir(), "alchemy-integration-pack-"));

try {
  const commit = await run(["git", "rev-parse", "--short=12", "HEAD"], {
    quiet: true,
  });
  const manifestsByName = await workspaceManifests();
  const alchemyManifestPath = join(alchemyPackageDir, "package.json");
  const alchemyManifest = await readManifest(alchemyManifestPath);
  if (alchemyManifest.name !== "alchemy") {
    throw new Error("Alchemy package manifest has an unexpected name");
  }

  const closure = new Map<string, { directory: string; manifest: Manifest }>();
  const visitWorkspace = async (manifestPath: string): Promise<void> => {
    const manifest = await readManifest(manifestPath);
    if (typeof manifest.name !== "string") {
      throw new Error(`${manifestPath} has no package name`);
    }
    if (closure.has(manifest.name)) return;
    closure.set(manifest.name, {
      directory: resolve(manifestPath, ".."),
      manifest,
    });

    for (const dependencyName of localDependencyNames(manifest)) {
      const dependencyManifest = manifestsByName.get(dependencyName);
      if (dependencyManifest === undefined) {
        throw new Error(
          `${manifest.name} depends on missing workspace package ${dependencyName}`,
        );
      }
      await visitWorkspace(dependencyManifest);
    }
  };
  await visitWorkspace(alchemyManifestPath);

  if (!skipBuild) {
    // Build dependencies before their consumers. `bun pm pack --ignore-scripts`
    // intentionally skips prepublish hooks, so the integration packer owns
    // creation of every runtime export target in the workspace closure.
    for (const { directory, manifest } of [...closure.values()].reverse()) {
      if (manifest.scripts?.build !== undefined) {
        await run(["bun", "run", "build"], { cwd: directory });
      }
    }
  }

  await mkdir(outputDir, { recursive: true });
  const packed = new Map<string, PackedWorkspace>();

  for (const { directory, manifest: originalManifest } of closure.values()) {
    const name = originalManifest.name!;
    const rawDir = join(temporaryDir, packageSlug(name));
    const stagingDir = join(rawDir, "staging");
    await mkdir(rawDir);
    await run(
      [
        "bun",
        "pm",
        "pack",
        "--destination",
        rawDir,
        "--ignore-scripts",
        "--quiet",
      ],
      { cwd: directory },
    );

    const rawTarballs = (await readdir(rawDir)).filter((entry) =>
      entry.endsWith(".tgz"),
    );
    if (rawTarballs.length !== 1) {
      throw new Error(
        `Expected one tarball for ${name}, found ${rawTarballs.length}`,
      );
    }
    await mkdir(stagingDir);
    await run(["tar", "-xzf", join(rawDir, rawTarballs[0]!), "-C", stagingDir]);

    const packedDirectory = join(stagingDir, "package");
    const sourceEntries = new Set(await readdir(directory));
    const packedEntries = new Set(await readdir(packedDirectory));
    // Bun resolves the `bun` export condition to workspace `src/*`, while
    // Node resolves the default condition to `lib/*` or `dist/*`. A package
    // tarball can contain only a filtered source subset even when its manifest
    // lists `src`, so replace each runtime tree from the workspace rather than
    // trusting the packer's file selection.
    for (const runtimeDirectory of ["src", "lib", "dist"]) {
      if (!sourceEntries.has(runtimeDirectory)) continue;
      const target = join(packedDirectory, runtimeDirectory);
      if (packedEntries.has(runtimeDirectory)) {
        await rm(target, { recursive: true, force: true });
      }
      await cp(join(directory, runtimeDirectory), target, { recursive: true });
    }
    const packedManifest = await readManifest(
      join(packedDirectory, "package.json"),
    );
    if (typeof packedManifest.version !== "string") {
      throw new Error(`${name} packed without a version`);
    }
    // A submodule checkout can contain compiled `lib`/`dist` without the
    // source tree named by its workspace-only Bun condition. Never publish a
    // condition whose target is absent: Bun treats it as authoritative and
    // does not fall through to the valid import target.
    await pruneMissingSourceConditions(packedDirectory, packedManifest.exports);
    // This plugin is loaded through Alchemy's self-resolver while bundling a
    // Lambda whose graph also reaches Worker infrastructure. Its sole runtime
    // export must therefore be resolvable from the installed archive itself.
    if (name === "@distilled.cloud/cloudflare-vite-plugin") {
      await verifyRuntimeExports(name, packedDirectory, packedManifest);
    }
    const contentHash = await hashTree(packedDirectory);
    const version = `${versionBase(packedManifest.version)}-samva.${commit}.${contentHash}`;
    const artifact = join(outputDir, `${packageSlug(name)}-${version}.tgz`);
    packed.set(name, {
      name,
      directory,
      originalManifest,
      packedDirectory,
      packedManifest,
      version,
      artifact,
    });
  }

  const alchemy = packed.get("alchemy");
  if (alchemy === undefined) throw new Error("Alchemy was not packed");
  const bundledWorkspaces = [...packed.values()].filter(
    (workspace) => workspace.name !== "alchemy",
  );

  for (const workspace of packed.values()) {
    workspace.packedManifest.version = workspace.version;
    for (const section of dependencySections) {
      const originalDependencies = workspace.originalManifest[section] ?? {};
      const packedDependencies = workspace.packedManifest[section];
      if (packedDependencies === undefined) continue;

      for (const [name, originalSpecifier] of Object.entries(
        originalDependencies,
      )) {
        if (!originalSpecifier.startsWith("workspace:")) continue;
        const dependency = packed.get(name);
        if (dependency === undefined) {
          throw new Error(`${workspace.name} has unpacked dependency ${name}`);
        }
        packedDependencies[name] = dependency.version;
      }

      for (const [name, specifier] of Object.entries(packedDependencies)) {
        if (
          specifier.startsWith("workspace:") ||
          specifier.startsWith("catalog:")
        ) {
          throw new Error(
            `${workspace.name} has unresolved ${section}.${name}: ${specifier}`,
          );
        }
      }
    }

    await writeFile(
      join(workspace.packedDirectory, "package.json"),
      `${JSON.stringify(workspace.packedManifest, null, 2)}\n`,
    );
  }

  // A package manager installs the root artifact's declared dependencies, but
  // it does not recursively install dependencies for packages that the
  // artifact already carries inside node_modules. Promote every external
  // runtime dependency of the bundled workspace closure to Alchemy's manifest;
  // workspace dependencies stay physically bundled and peers (notably Effect)
  // remain owned by the consumer.
  alchemy.packedManifest.dependencies ??= {};
  alchemy.packedManifest.optionalDependencies ??= {};
  for (const workspace of bundledWorkspaces) {
    for (const section of runtimeDependencySections) {
      for (const [name, specifier] of Object.entries(
        workspace.packedManifest[section] ?? {},
      )) {
        if (packed.has(name)) continue;

        const required = section === "dependencies";
        const declaredDependency = alchemy.packedManifest.dependencies[name];
        const declaredOptional =
          alchemy.packedManifest.optionalDependencies[name];
        const declared = declaredDependency ?? declaredOptional;
        if (declared !== undefined && declared !== specifier) {
          console.warn(
            `Keeping Alchemy's ${name}@${declared}; bundled ${workspace.name} declares ${specifier}`,
          );
        }

        if (required) {
          alchemy.packedManifest.dependencies[name] = declared ?? specifier;
          delete alchemy.packedManifest.optionalDependencies[name];
        } else if (declared === undefined) {
          alchemy.packedManifest.optionalDependencies[name] = specifier;
        }
      }
    }
  }

  alchemy.packedManifest.bundledDependencies = bundledWorkspaces.map(
    (workspace) => workspace.name,
  );
  for (const workspace of bundledWorkspaces) {
    delete alchemy.packedManifest.dependencies?.[workspace.name];
    delete alchemy.packedManifest.optionalDependencies?.[workspace.name];
  }

  const bundledContentHash = createHash("sha256")
    .update(
      JSON.stringify({
        workspaces: [...packed.values()]
          .map((workspace) => `${workspace.name}@${workspace.version}`)
          .sort(),
        dependencies: alchemy.packedManifest.dependencies,
        optionalDependencies: alchemy.packedManifest.optionalDependencies,
        bundledDependencies: alchemy.packedManifest.bundledDependencies,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  const alchemyVersion = `${versionBase(alchemy.version)}-samva.${commit}.${bundledContentHash}`;
  const alchemyArtifact = join(outputDir, `alchemy-${alchemyVersion}.tgz`);
  alchemy.packedManifest.version = alchemyVersion;
  await writeFile(
    join(alchemy.packedDirectory, "package.json"),
    `${JSON.stringify(alchemy.packedManifest, null, 2)}\n`,
  );

  const bundledNodeModules = join(alchemy.packedDirectory, "node_modules");
  for (const workspace of bundledWorkspaces) {
    const target = join(bundledNodeModules, ...workspace.name.split("/"));
    await mkdir(resolve(target, ".."), { recursive: true });
    await cp(workspace.packedDirectory, target, { recursive: true });
  }

  await rm(alchemyArtifact, { force: true });
  await run(
    [
      "bun",
      "pm",
      "pack",
      "--destination",
      outputDir,
      "--ignore-scripts",
      "--quiet",
    ],
    { cwd: alchemy.packedDirectory },
  );
  await lstat(alchemyArtifact);

  const archiveEntries = await run(["tar", "-tzf", alchemyArtifact], {
    quiet: true,
  });
  for (const workspace of bundledWorkspaces) {
    const manifestEntry = `package/node_modules/${workspace.name}/package.json`;
    if (!archiveEntries.split("\n").includes(manifestEntry)) {
      throw new Error(`Bundled tarball is missing ${manifestEntry}`);
    }
  }
  for (const requiredRuntimeEntry of [
    "package/node_modules/@distilled.cloud/aws/lib/index.js",
    "package/node_modules/@distilled.cloud/cloudflare/lib/services/accounts.js",
    "package/node_modules/@distilled.cloud/cloudflare-vite-plugin/dist/node/plugin.mjs",
  ]) {
    if (!archiveEntries.split("\n").includes(requiredRuntimeEntry)) {
      throw new Error(`Bundled tarball is missing ${requiredRuntimeEntry}`);
    }
  }

  await verifyFreshConsumer(alchemyArtifact);

  console.log(`\nPacked ${packed.size} local workspace packages`);
  console.log(`Created ${alchemyArtifact}`);
  console.log(`Version ${alchemyVersion}`);
  console.log(`Bundled ${bundledWorkspaces.length} workspace dependencies`);
  console.log(`Consumer dependency: "alchemy": "file:${alchemyArtifact}"`);
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
