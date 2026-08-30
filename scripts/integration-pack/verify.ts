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
      `import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const [Alchemy, AWS, AwsEnvironmentModule, AwsEndpointModule, AwsCredentialsModule, FlociFunctionProvider, LambdaBootstrap, ProcessBootstrap, RuntimeContextModule, Cloudflare, CloudflareEnvironmentModule, Fly, FetchHttpClientModule] = await Promise.all([
  import("alchemy"),
  import("alchemy/AWS"),
  import("alchemy/AWS/Environment"),
  import("alchemy/AWS/Endpoint"),
  import("alchemy/AWS/Credentials"),
  import("alchemy/AWS/Lambda/FlociFunctionProvider"),
  import("alchemy/Runtime/Bootstrap/Lambda"),
  import("alchemy/Runtime/Bootstrap/Process"),
  import("alchemy/RuntimeContext"),
  import("alchemy/Cloudflare"),
  import("alchemy/Cloudflare/CloudflareEnvironment"),
  import("alchemy/Fly"),
  import("effect/unstable/http/FetchHttpClient"),
]);
if (!Alchemy.Stack || !AWS.Lambda || !Cloudflare.Worker || !Cloudflare.cloudflareViteFramework || !CloudflareEnvironmentModule.CloudflareEnvironment || !Fly.Machine) {
  throw new Error("packed Node runtime surfaces did not load");
}

Object.assign(process.env, {
  ALCHEMY_AWS_ACCOUNT_ID: "654654387918",
  ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify({
    servicequotas: "http://host.docker.internal:8800/service-quotas",
    ses: "http://host.docker.internal:8800/ses",
    sesv2: "http://host.docker.internal:8800/ses",
  }),
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
  set: (key) => Effect.succeed(key),
  exports: Effect.succeed({
    handler: Effect.gen(function* () {
      const environment = yield* AwsEnvironmentModule.AWSEnvironment.current;
      const context = yield* RuntimeContextModule.RuntimeContext;
      return async () => ({
        accountId: environment.accountId,
        region: environment.region,
        runtimeContextId: context.id,
        serviceEndpoints: environment.serviceEndpoints,
      });
    }),
  }),
};
const entrypoint = Layer.succeed(ProcessBootstrap.entrypointTag, {
  RuntimeContext: runtimeContext,
});
const handler = await LambdaBootstrap.bootstrap(entrypoint);
const identity = await handler({}, {});
if (identity.accountId !== "654654387918" || identity.region !== "us-east-1" || identity.runtimeContextId !== "SamvaApi") {
  throw new Error(\`packaged Lambda runtime resolved \${JSON.stringify(identity)}\`);
}
if (identity.serviceEndpoints?.servicequotas !== "http://host.docker.internal:8800/service-quotas" || identity.serviceEndpoints?.ses !== "http://host.docker.internal:8800/ses" || identity.serviceEndpoints?.sesv2 !== "http://host.docker.internal:8800/ses") {
  throw new Error(\`packaged Lambda runtime service endpoints resolved \${JSON.stringify(identity.serviceEndpoints)}\`);
}
const localEnvironment = await Effect.runPromise(
  FlociFunctionProvider.localEmulatorFunctionEnvironment(
    {
      DATABASE_URL: RuntimeContextModule.packEnvValue(Redacted.make("postgres://127.0.0.1:54329/samva")),
      REDIS_URL: RuntimeContextModule.packEnvValue(Redacted.make("redis://127.0.0.1:56379/2")),
    },
    {
      environment: Effect.succeed({
        DATABASE_URL: Redacted.make("postgres://postgres:5432/samva"),
        REDIS_URL: Redacted.make("redis://redis:6379/2"),
      }),
    },
  ),
);
const localDatabaseUrl = Redacted.value(RuntimeContextModule.unpackEnvValue(localEnvironment.DATABASE_URL));
const localRedisUrl = Redacted.value(RuntimeContextModule.unpackEnvValue(localEnvironment.REDIS_URL));
if (localDatabaseUrl !== "postgres://postgres:5432/samva" || localRedisUrl !== "redis://redis:6379/2") {
  throw new Error(\`packaged local Lambda environment resolved \${JSON.stringify(localEnvironment)}\`);
}
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
  const endpoint = \`http://127.0.0.1:\${address.port}\`;
  await Effect.runPromise(
    Effect.gen(function* () {
      const listServices = yield* AWS.ServiceQuotas.ListServices();
      return yield* listServices({});
    }).pipe(
      Effect.provide(AWS.ServiceQuotas.ListServicesHttp),
      Effect.provide(
        AwsCredentialsModule.fromCredentials({
          accessKeyId: "checkpoint-test",
          secretAccessKey: "checkpoint-test",
        }, "us-east-1"),
      ),
      Effect.provide(
        AwsEndpointModule.fromEnvironmentWithServiceEndpoints(
          Effect.succeed({ servicequotas: endpoint }),
        ),
      ),
      Effect.provide(FetchHttpClientModule.layer),
    ),
  );
  if (requests.length !== 1 || requests[0]?.method !== "POST" || requests[0]?.url !== "/") {
    throw new Error(\`packaged service endpoint request was \${JSON.stringify(requests)}\`);
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log("compiled Alchemy Node runtime, packaged Lambda bootstrap, local environment, and service endpoint request routing passed");
`,
    );
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
