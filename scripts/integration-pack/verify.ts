import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./io.ts";
import {
  assertPublishableManifest,
  assertSafeArchiveEntries,
} from "./staging.ts";
import type { PackageManifest, PackedPackage } from "./types.ts";

/**
 * Every `alchemy` subpath Samva imports. The archive check resolves each one
 * through the packed export map for every condition, and the fresh consumers
 * import each one under Bun (`bun` → `src`), TypeScript (`types` → `lib`
 * declarations), and Node (`default` → `lib`).
 */
export const consumerSubpaths = [
  "alchemy",
  "alchemy/AWS",
  "alchemy/AWS/ACM",
  "alchemy/AWS/ApiGatewayV2",
  "alchemy/AWS/CloudControl",
  "alchemy/AWS/CloudWatch",
  "alchemy/AWS/Endpoint",
  "alchemy/AWS/EventBridge",
  "alchemy/AWS/IAM",
  "alchemy/AWS/KMS",
  "alchemy/AWS/Lambda",
  "alchemy/AWS/Lambda/Durable",
  "alchemy/AWS/Lambda/FlociFunctionProvider",
  "alchemy/AWS/Lambda/Function",
  "alchemy/AWS/Lambda/HttpServer",
  "alchemy/AWS/Logs",
  "alchemy/AWS/S3",
  "alchemy/AWS/SES",
  "alchemy/AWS/SNS",
  "alchemy/AWS/SQS",
  "alchemy/AWS/SecretsManager",
  "alchemy/Axiom",
  "alchemy/Cloudflare",
  "alchemy/Cloudflare/ApiToken",
  "alchemy/Cloudflare/CloudflareEnvironment",
  "alchemy/Cloudflare/DNS",
  "alchemy/Cloudflare/Email",
  "alchemy/Cloudflare/Flagship",
  "alchemy/Cloudflare/R2",
  "alchemy/Cloudflare/Ruleset",
  "alchemy/Cloudflare/VitePlugin",
  "alchemy/Cloudflare/Zone",
  "alchemy/Command",
  "alchemy/Docker",
  "alchemy/Output",
  "alchemy/Planetscale",
  "alchemy/Provider",
  "alchemy/State",
] as const;

const exportConditions = ["types", "bun", "default"] as const;

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

/**
 * Resolve one package subpath through an export map the way Node does: an
 * exact key wins, otherwise the single-`*` pattern with the longest prefix.
 * Returns the matched value with `*` substituted, `null` for an explicitly
 * blocked subpath, or `undefined` when nothing matches.
 */
export const resolveExportSubpath = (
  exports: unknown,
  subpath: string,
): unknown => {
  if (typeof exports !== "object" || exports === null || Array.isArray(exports))
    return undefined;
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
      Object.entries(value).map(([condition, target]) => [
        condition,
        substitute(target),
      ]),
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
    const subpath =
      specifier === manifest.name
        ? "."
        : `./${specifier.slice(`${manifest.name}/`.length)}`;
    const resolved = resolveExportSubpath(manifest.exports, subpath);
    if (resolved === undefined || resolved === null)
      throw new Error(`${specifier} is not exported by the packed manifest`);
    for (const condition of exportConditions) {
      const target =
        typeof resolved === "string"
          ? resolved
          : (resolved as Record<string, unknown>)[condition];
      if (typeof target !== "string")
        throw new Error(`${specifier} has no ${condition} export condition`);
      if (!entries.has(`package/${target.slice(2)}`))
        throw new Error(
          `${specifier} (${condition}) resolves to missing packaged file ${target}`,
        );
    }
  }
};

/**
 * A bundled package must be the local build, not a same-versioned registry
 * copy that won hoisting: every file of the local archive is present.
 */
export const assertBundledFiles = (
  entries: ReadonlySet<string>,
  name: string,
  localEntries: ReadonlyArray<string>,
): void => {
  const missing = localEntries
    .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"))
    .map((entry) => `package/node_modules/${name}/${entry.slice(8)}`)
    .filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `Archive bundles a ${name} that is not the local build; missing ${missing.length} files, e.g. ${missing.slice(0, 3).join(", ")}`,
    );
  }
};

const assertBundledLocalBuild = async (
  entries: ReadonlySet<string>,
  packed: PackedPackage,
): Promise<void> =>
  assertBundledFiles(
    entries,
    packed.name,
    (
      await run(["tar", "-tzf", packed.tarball], {
        cwd: process.cwd(),
        quiet: true,
      })
    ).split("\n"),
  );

const requiredRuntimeOutputs = [
  "package/lib/index.js",
  "package/src/index.ts",
  "package/node_modules/@distilled.cloud/core/lib/api.js",
  "package/node_modules/@distilled.cloud/aws/lib/endpoint.js",
  "package/node_modules/@distilled.cloud/aws/lib/services/s3.js",
  "package/node_modules/@distilled.cloud/cloudflare/lib/services/accounts.js",
  "package/node_modules/@distilled.cloud/fly-io/lib/services/machines.js",
  "package/node_modules/@alchemy.run/cloudflare-runtime/package.json",
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
  assertConsumerSubpaths(entries, rootManifest);

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
    await assertBundledLocalBuild(entries, packed);
  }

  for (const entry of requiredRuntimeOutputs) {
    if (!entries.has(entry))
      throw new Error(`Archive is missing required runtime output ${entry}`);
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

/** Bun source surface (`bun` condition) plus the published declarations. */
const bunConsumer = (): string => `${moduleImports("static")}

${assertModulesLoaded("Bun", `[${consumerSubpaths.map(m).join(", ")}]`)}

if (
  !${m("alchemy/AWS")}.Lambda ||
  !${m("alchemy/Cloudflare")}.Worker ||
  typeof ${m("alchemy/Cloudflare/CloudflareEnvironment")}.CloudflareEnvironment !== "function" ||
  typeof ${m("alchemy/Cloudflare/VitePlugin")}.vitePlugin !== "function" ||
  typeof ${m("alchemy/AWS/Endpoint")}.services !== "function" ||
  typeof ${m("alchemy/AWS/Lambda/FlociFunctionProvider")}.placeLocalLambdaEnvironment !== "function" ||
  typeof ${m("alchemy/AWS/Lambda/Function")}.lambdaEnvironmentSize !== "function" ||
  typeof ${m("alchemy/AWS/Lambda/HttpServer")}.isFunctionURLEvent !== "function"
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
const bootstrapConsumer =
  (): string => `import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWS_SERVICE_ENDPOINTS, AWSEnvironment } from "alchemy/AWS";
import * as LambdaBootstrap from "alchemy/Runtime/Bootstrap/Lambda";
import * as ProcessBootstrap from "alchemy/Runtime/Bootstrap/Process";

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
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const modules = await Promise.all([
${moduleImports("dynamic")}
]);
${assertModulesLoaded("Node", "modules")}
const [Alchemy, AWS] = modules;
const Endpoint = modules[${consumerSubpaths.indexOf("alchemy/AWS/Endpoint")}];
const FlociFunctionProvider = modules[${consumerSubpaths.indexOf("alchemy/AWS/Lambda/FlociFunctionProvider")}];
const Cloudflare = modules[${consumerSubpaths.indexOf("alchemy/Cloudflare")}];
const CloudflareEnvironment = modules[${consumerSubpaths.indexOf("alchemy/Cloudflare/CloudflareEnvironment")}];
const VitePlugin = modules[${consumerSubpaths.indexOf("alchemy/Cloudflare/VitePlugin")}];
const [Credentials, RuntimeContext] = await Promise.all([
  import("alchemy/AWS/Credentials"),
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
      Effect.provide(
        Credentials.fromCredentials(
          { accessKeyId: "checkpoint-test", secretAccessKey: "checkpoint-test" },
          "us-east-1",
        ),
      ),
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
console.log(\`Node resolved \${consumerSubpaths.length} Samva subpaths, local Lambda placement, and per-service endpoint routing\`);
`;

export interface ConsumerDependencies {
  /** Exact Effect family version the consumer installs beside the artifact. */
  readonly effect: string;
}

/**
 * Install into a new consumer and exercise the source, declaration, and
 * compiled surfaces Samva imports.
 */
export const verifyFreshConsumer = async (
  artifact: string,
  dependencies: ConsumerDependencies,
): Promise<void> => {
  const consumer = await mkdtemp(
    join(tmpdir(), "alchemy-integration-consumer-"),
  );
  try {
    await mkdir(consumer, { recursive: true });
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          dependencies: {
            alchemy: `file:${artifact}`,
            effect: dependencies.effect,
            "@effect/platform-node": dependencies.effect,
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(consumer, "consumer.ts"), bunConsumer());
    await writeFile(
      join(consumer, "consumer-bootstrap.ts"),
      bootstrapConsumer(),
    );
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
    await run(["bun", "consumer-bootstrap.ts"], { cwd: consumer });
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
