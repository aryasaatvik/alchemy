import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { run } from "./io.ts";
import { assertPublishableManifest, assertSafeArchiveEntries } from "./staging.ts";
import type { PackageManifest, PackedPackage } from "./types.ts";

/**
 * Every `alchemy` subpath Samva imports. The archive check resolves each one
 * through the packed export map for every condition, and the fresh consumers
 * import each one under Bun (`bun` → `src`), TypeScript (`types` → `lib`
 * declarations), and Node (`default` → `lib`).
 */
export const consumerSubpaths = [
  "alchemy",
  "@alchemy.run/aws",
  "@alchemy.run/aws/ACM",
  "@alchemy.run/aws/ApiGatewayV2",
  "@alchemy.run/aws/CloudControl",
  "@alchemy.run/aws/CloudWatch",
  "@alchemy.run/aws/Endpoint",
  "@alchemy.run/aws/EventBridge",
  "@alchemy.run/aws/IAM",
  "@alchemy.run/aws/KMS",
  "@alchemy.run/aws/Lambda",
  "@alchemy.run/aws/Lambda/Durable",
  "@alchemy.run/aws/Lambda/FlociFunctionProvider",
  "@alchemy.run/aws/Lambda/Function",
  "@alchemy.run/aws/Lambda/HttpServer",
  "@alchemy.run/aws/Logs",
  "@alchemy.run/aws/S3",
  "@alchemy.run/aws/SES",
  "@alchemy.run/aws/SNS",
  "@alchemy.run/aws/SQS",
  "@alchemy.run/aws/SecretsManager",
  "@alchemy.run/axiom",
  "@alchemy.run/cloudflare",
  "@alchemy.run/cloudflare/ApiToken",
  "@alchemy.run/cloudflare/CloudflareEnvironment",
  "@alchemy.run/cloudflare/DNS",
  "@alchemy.run/cloudflare/Email",
  "@alchemy.run/cloudflare/Flagship",
  "@alchemy.run/cloudflare/R2",
  "@alchemy.run/cloudflare/Ruleset",
  "@alchemy.run/cloudflare/VitePlugin",
  "@alchemy.run/cloudflare/Zone",
  "alchemy/Command",
  "@alchemy.run/docker",
  "alchemy/Output",
  "@alchemy.run/planetscale",
  "alchemy/Provider",
  "alchemy/State",
  "@alchemy.run/git",
  "@alchemy.run/drizzle",
  "@alchemy.run/sql/PostgresState",
  "@alchemy.run/aws/Contributions",
  "@alchemy.run/cloudflare/Contributions",
  "@alchemy.run/axiom/Contributions",
] as const;

const exportConditions = ["types", "bun", "default"] as const;

const archiveEntries = async (archive: string): Promise<ReadonlySet<string>> => {
  const entries = (await run(["tar", "-tzf", archive], { cwd: process.cwd(), quiet: true })).split(
    "\n",
  );
  assertSafeArchiveEntries(entries);
  return new Set(entries);
};

const packageManifests = async (
  archive: string,
  entries: ReadonlySet<string>,
): Promise<ReadonlyMap<string, PackageManifest>> => {
  const manifestEntries = [...entries].filter(
    (entry) =>
      entry === "package/package.json" || /^package\/node_modules\/.+\/package\.json$/.test(entry),
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
        `^${archiveTarget.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]+")}$`,
      );
      if (![...entries].some((entry) => pattern.test(entry))) {
        throw new Error(`${manifest.name} exports missing packaged target ${target}`);
      }
    } else if (!entries.has(archiveTarget)) {
      throw new Error(`${manifest.name} exports missing packaged target ${target}`);
    }
  }
};

/**
 * Resolve one package subpath through an export map the way Node does: an
 * exact key wins, otherwise the single-`*` pattern with the longest prefix.
 * Returns the matched value with `*` substituted, `null` for an explicitly
 * blocked subpath, or `undefined` when nothing matches.
 */
export const resolveExportSubpath = (exports: unknown, subpath: string): unknown => {
  if (typeof exports !== "object" || exports === null || Array.isArray(exports)) return undefined;
  const map = exports as Record<string, unknown>;
  if (subpath in map) return map[subpath];
  let best: { readonly key: string; readonly match: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length >= key.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (best === undefined || prefix.length > best.key.indexOf("*"))
    ) {
      best = {
        key,
        match: subpath.slice(prefix.length, subpath.length - suffix.length),
      };
    }
  }
  if (best === undefined) return undefined;
  const substitute = (value: unknown): unknown => {
    if (typeof value === "string") return value.replaceAll("*", best!.match);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([condition, target]) => [condition, substitute(target)]),
    );
  };
  return substitute(map[best.key]);
};

/** Every consumer subpath resolves to a packaged file for every condition. */
export const assertConsumerSubpaths = (
  entries: ReadonlySet<string>,
  manifest: PackageManifest,
  subpaths: ReadonlyArray<string> = consumerSubpaths,
): void => {
  for (const specifier of subpaths) {
    if (specifier !== manifest.name && !specifier.startsWith(`${manifest.name}/`)) continue;
    const subpath =
      specifier === manifest.name ? "." : `./${specifier.slice(`${manifest.name}/`.length)}`;
    const resolved = resolveExportSubpath(manifest.exports, subpath);
    if (resolved === undefined || resolved === null)
      throw new Error(`${specifier} is not exported by the packed manifest`);
    for (const condition of exportConditions) {
      const target =
        typeof resolved === "string" ? resolved : (resolved as Record<string, unknown>)[condition];
      if (typeof target !== "string")
        throw new Error(`${specifier} has no ${condition} export condition`);
      if (!entries.has(`package/${target.slice(2)}`))
        throw new Error(`${specifier} (${condition}) resolves to missing packaged file ${target}`);
    }
  }
};

/** Validate a standalone core/provider/SDK archive before caching it. */
export const verifyPackageArchive = async (archive: string): Promise<void> => {
  const entries = await archiveEntries(archive);
  const manifests = await packageManifests(archive, entries);
  const manifest = manifests.get("package/package.json");
  if (manifest === undefined) throw new Error("Archive has no package manifest");
  assertPublishableManifest(manifest.name ?? "unnamed package", manifest);
  assertArchiveExportTargets(entries, "package", manifest);
  assertConsumerSubpaths(entries, manifest);
  const metadata = manifest.alchemy as { contributes?: ReadonlyArray<string> } | undefined;
  if (metadata?.contributes !== undefined)
    assertConsumerSubpaths(entries, manifest, metadata.contributes);
  if (manifest.name?.startsWith("@distilled.cloud/")) {
    for (const entry of entries) {
      if (/^package\/src\/services\/[^/]+\.ts$/.test(entry) && !entry.endsWith(".test.ts")) {
        const service = entry.slice("package/src/services/".length, -3);
        for (const target of [
          `lib/services/${service}.d.ts`,
          `lib/services/${service}.js`,
          `lib/services.full/${service}.js`,
        ])
          if (!entries.has(`package/${target}`))
            throw new Error(`${manifest.name} is missing service publication ${target}`);
      }
      if (!/^package\/lib\/services\/[^/]+\.js$/.test(entry)) continue;
      if (!entries.has(entry.replace("/services/", "/services.full/")))
        throw new Error(`${manifest.name} is missing the full-service publication for ${entry}`);
    }
    if (
      manifest.name === "@distilled.cloud/core" &&
      ![...entries].some(
        (entry) => entry.startsWith("package/lib/_bundle/") && entry.endsWith(".js"),
      )
    )
      throw new Error("Distilled core archive has no shared bundle chunks");
    const directory = await mkdtemp(join(tmpdir(), "alchemy-sdk-archive-"));
    try {
      await run(["tar", "-xzf", archive, "-C", directory], { cwd: directory });
      const transpiler = new Bun.Transpiler({ loader: "js" });
      for (const entry of entries) {
        if (!entry.startsWith("package/lib/") || !/\.[cm]?js$/.test(entry)) continue;
        const source = await readFile(join(directory, entry), "utf8");
        for (const imported of transpiler.scanImports(source)) {
          if (!imported.path.startsWith(".")) continue;
          const target = posix.normalize(posix.join(posix.dirname(entry), imported.path));
          if (!entries.has(target))
            throw new Error(
              `${manifest.name} imports absent archive chunk ${target} from ${entry}`,
            );
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
};

/** The static-import binding for one consumer subpath. */
const m = (specifier: (typeof consumerSubpaths)[number]): string =>
  `M${consumerSubpaths.indexOf(specifier)}`;

const moduleImports = (style: "static" | "dynamic"): string =>
  consumerSubpaths
    .map((specifier, index) =>
      style === "static"
        ? `import * as M${index} from "${specifier}";`
        : `  import("${specifier}"),`,
    )
    .join("\n");

/** Fails when any imported consumer subpath has no runtime exports. */
const assertModulesLoaded = (label: string, modules: string): string =>
  `const consumerSubpaths = ${JSON.stringify(consumerSubpaths)};
${modules}.forEach((module, index) => {
  if (Object.keys(module).length === 0) {
    throw new Error(\`${label}: \${consumerSubpaths[index]} loaded without exports\`);
  }
});`;

/** One credential boundary for the typed declaration probe and Node routing probe. */
const checkpointCredentialsLayer = (): string => `Credentials.fromCredentials(
  {
    accessKeyId: Redacted.make("checkpoint-test"),
    secretAccessKey: Redacted.make("checkpoint-test"),
  },
  "us-east-1",
)`;

/** Bun source surface (`bun` condition) plus the published declarations. */
const bunConsumer = (): string => `import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Redacted from "effect/Redacted";
${moduleImports("static")}

${checkpointCredentialsLayer()};

${assertModulesLoaded("Bun", `[${consumerSubpaths.map(m).join(", ")}]`)}

if (
  !${m("@alchemy.run/aws")}.Lambda ||
  !${m("@alchemy.run/cloudflare")}.Worker ||
  typeof ${m("@alchemy.run/cloudflare/CloudflareEnvironment")}.CloudflareEnvironment !== "function" ||
  typeof ${m("@alchemy.run/cloudflare/VitePlugin")}.vitePlugin !== "function" ||
  typeof ${m("@alchemy.run/aws/Endpoint")}.services !== "function" ||
  typeof ${m("@alchemy.run/aws/Lambda/FlociFunctionProvider")}.placeLocalLambdaEnvironment !== "function" ||
  typeof ${m("@alchemy.run/aws/Lambda/Function")}.lambdaEnvironmentSize !== "function" ||
  typeof ${m("@alchemy.run/aws/Lambda/HttpServer")}.isFunctionURLEvent !== "function"
) {
  throw new Error("packed Bun runtime surfaces did not load");
}
console.log(\`Bun resolved \${consumerSubpaths.length} Samva subpaths\`);
`;

/**
 * The packaged Lambda bootstrap under Bun. Its export points at source for
 * every condition (the deployment bundler consumes it), so Node cannot load
 * it from node_modules directly.
 */
const bootstrapConsumer = (): string => `import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWS_SERVICE_ENDPOINTS, AWSEnvironment } from "@alchemy.run/aws";
import * as LambdaBootstrap from "@alchemy.run/aws/Bootstrap/Lambda";
import * as ProcessBootstrap from "alchemy/Runtime/Bootstrap";

const serviceEndpoints = {
  "Service Quotas": "http://host.docker.internal:8800/service-quotas",
  SESv2: "http://host.docker.internal:8800/ses",
};
Object.assign(process.env, {
  ALCHEMY_AWS_ACCOUNT_ID: "654654387918",
  ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify(serviceEndpoints),
  ALCHEMY_STACK_NAME: "samva",
  ALCHEMY_STAGE: "production",
  AWS_ACCESS_KEY_ID: "checkpoint-test",
  AWS_SECRET_ACCESS_KEY: "checkpoint-test",
  AWS_SESSION_TOKEN: "checkpoint-test",
  AWS_REGION: "us-east-1",
});
const runtimeContext = {
  Type: "AWS.Lambda.Function",
  id: "SamvaApi",
  env: {},
  get: () => Effect.succeed(undefined),
  set: (key: string) => Effect.succeed(key),
  exports: Effect.succeed({
    handler: Effect.gen(function* () {
      const environment = yield* AWSEnvironment.current;
      const endpoints = yield* AWS_SERVICE_ENDPOINTS;
      return async () => ({
        accountId: environment.accountId,
        region: environment.region,
        runtimeContextId: runtimeContext.id,
        serviceEndpoints: endpoints,
      });
    }),
  }),
};
const entrypoint = Layer.succeed(ProcessBootstrap.entrypointTag, {
  RuntimeContext: runtimeContext,
});
const handler = (await LambdaBootstrap.bootstrap(entrypoint)) as (
  event: unknown,
  context: unknown,
) => Promise<{
  accountId: string;
  region: string;
  runtimeContextId: string;
  serviceEndpoints: Record<string, string> | undefined;
}>;
const identity = await handler({}, {});
if (
  identity.accountId !== "654654387918" ||
  identity.region !== "us-east-1" ||
  identity.runtimeContextId !== "SamvaApi" ||
  JSON.stringify(identity.serviceEndpoints) !== JSON.stringify(serviceEndpoints)
) {
  throw new Error(\`packaged Lambda runtime resolved \${JSON.stringify(identity)}\`);
}
console.log("packaged Lambda bootstrap resolved its account, Region, stack, and service endpoints");
process.exit(0);
`;

/** Compiled `lib` surface (`default` condition) under Node. */
const nodeConsumer = (): string => `import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const modules = await Promise.all([
${moduleImports("dynamic")}
]);
${assertModulesLoaded("Node", "modules")}
const [Alchemy, AWS] = modules;
const Endpoint = modules[${consumerSubpaths.indexOf("@alchemy.run/aws/Endpoint")}];
const FlociFunctionProvider = modules[${consumerSubpaths.indexOf("@alchemy.run/aws/Lambda/FlociFunctionProvider")}];
const Cloudflare = modules[${consumerSubpaths.indexOf("@alchemy.run/cloudflare")}];
const CloudflareEnvironment = modules[${consumerSubpaths.indexOf("@alchemy.run/cloudflare/CloudflareEnvironment")}];
const VitePlugin = modules[${consumerSubpaths.indexOf("@alchemy.run/cloudflare/VitePlugin")}];
const [Credentials, RuntimeContext] = await Promise.all([
  import("@alchemy.run/aws/Credentials"),
  import("alchemy/RuntimeContext"),
]);
if (!Alchemy.Stack || !AWS.Lambda || !Cloudflare.Worker || !CloudflareEnvironment.CloudflareEnvironment || typeof VitePlugin.vitePlugin !== "function") {
  throw new Error("packed Node runtime surfaces did not load");
}

const placed = FlociFunctionProvider.placeLocalLambdaEnvironment(
  {
    DATABASE_URL: RuntimeContext.packEnvValue(Redacted.make("postgres://127.0.0.1:54329/samva")),
    LOG_LEVEL: "debug",
  },
  {
    endpoint: "http://floci:4566",
    serviceEndpoints: { SESv2: "http://host.docker.internal:8800/ses" },
    environment: { DATABASE_URL: "postgres://postgres:5432/samva" },
  },
);
const databaseUrl = RuntimeContext.unpackEnvValue(placed.DATABASE_URL);
if (
  !Redacted.isRedacted(databaseUrl) ||
  Redacted.value(databaseUrl) !== "postgres://postgres:5432/samva" ||
  placed.LOG_LEVEL !== "debug" ||
  placed.AWS_ENDPOINT_URL !== "http://floci:4566" ||
  placed.ALCHEMY_AWS_SERVICE_ENDPOINTS !== JSON.stringify({ SESv2: "http://host.docker.internal:8800/ses" })
) {
  throw new Error(\`packaged local Lambda placement resolved \${JSON.stringify(placed)}\`);
}

globalThis.__ALCHEMY_RUNTIME__ = true;
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url, target: request.headers["x-amz-target"] });
  request.resume();
  response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
  response.end(JSON.stringify({ Services: [] }));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback endpoint server did not expose a port");
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const listServices = yield* AWS.ServiceQuotas.ListServices();
      return yield* listServices({});
    }).pipe(
      Effect.provide(AWS.ServiceQuotas.ListServicesHttp),
      Effect.provide(${checkpointCredentialsLayer()}),
      Effect.provide(Endpoint.services({ "Service Quotas": \`http://127.0.0.1:\${address.port}\` })),
      Effect.provide(FetchHttpClient.layer),
    ),
  );
  if (requests.length !== 1 || requests[0]?.method !== "POST" || requests[0]?.url !== "/" || !String(requests[0]?.target).endsWith(".ListServices")) {
    throw new Error(\`packaged service endpoint request was \${JSON.stringify(requests)}\`);
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
const Contributions = await import("alchemy/Contributions");
const NodeServices = await import("@effect/platform-node/NodeServices");
const contributions = await Effect.runPromise(Contributions.load(process.cwd()).pipe(Effect.provide(NodeServices.layer)));
for (const name of ["aws", "cloudflare", "axiom", "planetscale"]) {
  if (!contributions.some((provider) => provider.name === name))
    throw new Error("Installed provider is not discoverable through Contributions: " + name);
}
console.log(\`Node resolved \${consumerSubpaths.length} Samva subpaths, local Lambda placement, and per-service endpoint routing\`);
`;

export interface ConsumerDependencies {
  /** Exact Effect family version the consumer installs beside the artifact. */
  readonly effect: string;
  readonly packages?: ReadonlyArray<PackedPackage>;
}

/** Host dependencies required by the public integrations exercised below. */
export const freshConsumerManifest = (
  artifact: string,
  manifest: PackageManifest,
  dependencies: ConsumerDependencies,
): PackageManifest => {
  const vite = manifest.peerDependencies?.vite;
  if (vite === undefined || vite.length === 0) {
    throw new Error("Packed Alchemy must declare its Vite host peer");
  }
  assertPublishableManifest("alchemy", manifest);
  return {
    private: true,
    type: "module",
    dependencies: {
      ...Object.fromEntries(
        (dependencies.packages ?? []).map((packed) => [packed.name, `file:${packed.tarball}`]),
      ),
      alchemy: `file:${artifact}`,
      effect: dependencies.effect,
      "@effect/platform-node": dependencies.effect,
      // The VitePlugin subpath requires the application's Vite host. Its
      // optional peer is not installed automatically by Bun.
      vite,
    },
    // `@effect/platform-node` ranges its shared package, so a newer
    // Effect family release would otherwise land beside the pinned
    // `effect` and fail to resolve modules that version adds.
    overrides: {
      ...Object.fromEntries(
        (dependencies.packages ?? []).map((packed) => [packed.name, `file:${packed.tarball}`]),
      ),
      effect: dependencies.effect,
      "@effect/platform-node-shared": dependencies.effect,
    },
  };
};

/**
 * Install into a new consumer and exercise the source, declaration, and
 * compiled surfaces Samva imports.
 */
export const verifyFreshConsumer = async (
  artifact: string,
  dependencies: ConsumerDependencies,
): Promise<void> => {
  const manifest = JSON.parse(
    await run(["tar", "-xOf", artifact, "package/package.json"], {
      cwd: process.cwd(),
      quiet: true,
    }),
  ) as PackageManifest;
  const consumerManifest = freshConsumerManifest(artifact, manifest, dependencies);
  const consumer = await mkdtemp(join(tmpdir(), "alchemy-integration-consumer-"));
  try {
    await mkdir(consumer, { recursive: true });
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify(consumerManifest, null, 2)}\n`,
    );
    await writeFile(join(consumer, "consumer.ts"), bunConsumer());
    await writeFile(join(consumer, "consumer-bootstrap.ts"), bootstrapConsumer());
    await writeFile(join(consumer, "consumer-node.mjs"), nodeConsumer());
    await writeFile(
      join(consumer, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { module: "preserve", moduleResolution: "bundler", noEmit: true, skipLibCheck: true, strict: true, target: "ESNext" }, include: ["consumer.ts"] }, null, 2)}\n`,
    );
    // Bun loads .env automatically; the runtime checks set their own
    // environment and must not be steered by an ambient file.
    await writeFile(join(consumer, ".env"), "AWS_REGION=ap-south-1\n");
    await run(["bun", "install", "--ignore-scripts", "--backend=copyfile"], {
      cwd: consumer,
    });
    // Use the installed producer compiler, whose exact version is locked,
    // rather than resolving a new compiler while validating an artifact.
    await run([resolve(import.meta.dir, "../../node_modules/.bin/tsc"), "-p", "tsconfig.json"], {
      cwd: consumer,
    });
    await run(["bun", "consumer.ts"], { cwd: consumer });
    await run(["bun", "consumer-bootstrap.ts"], { cwd: consumer });
    await run(["node", "consumer-node.mjs"], { cwd: consumer });
    await run(["node", "--conditions=module", "consumer-node.mjs"], { cwd: consumer });
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
