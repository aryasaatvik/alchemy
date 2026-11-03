// Extensions bundle to exactly one module, so imports here are type-only.
import type {
  ArtifactsBlobWire,
  ArtifactsRepositoryMetadataResult,
  ArtifactsRepositoryWireOperations,
} from "./ArtifactsRpc.ts";

interface ProxyClient {
  create(...args: Parameters<Artifacts["create"]>): Promise<string>;
  import(...args: Parameters<Artifacts["import"]>): Promise<string>;
  list(...args: Parameters<Artifacts["list"]>): Promise<string>;
  delete(...args: Parameters<Artifacts["delete"]>): Promise<string>;
  artifactsGetMetadata(name: string): Promise<ArtifactsRepositoryMetadataResult>;
  artifactsGetMethods(name: string): Promise<ArtifactsRepositoryWireOperations & Disposable>;
}

interface Env {
  proxyClient: ProxyClient;
}

const decode = (json: string) => {
  const result = JSON.parse(json);
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
  return result.value;
};

const decodeBlob = (json: string): Blob | null => {
  const result: ArtifactsBlobWire | null = decode(json);
  return result === null
    ? null
    : new Blob([Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0))], {
        type: result.type,
      });
};

/** Rebuild the native capability, including fresh info, Git reads and disposal. */
export default function makeBinding(env: Env): Artifacts {
  return {
    create: async (...args) => decode(await env.proxyClient.create(...args)),
    import: async (...args) => decode(await env.proxyClient.import(...args)),
    list: async (...args) => decode(await env.proxyClient.list(...args)),
    delete: async (...args) => decode(await env.proxyClient.delete(...args)),
    async get(name) {
      const result = await env.proxyClient.artifactsGetMetadata(name);
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
      const methods = await env.proxyClient.artifactsGetMethods(name);
      return {
        [Symbol.dispose]: () => methods[Symbol.dispose](),
        info: async () => decode(await methods.info()),
        createToken: async (...args) => decode(await methods.createToken(...args)),
        listTokens: async () => decode(await methods.listTokens()),
        revokeToken: async (...args) => decode(await methods.revokeToken(...args)),
        fork: async (...args) => decode(await methods.fork(...args)),
        readBlob: async (...args) => decodeBlob(await methods.readBlob(...args)),
        readTree: async (...args) => decode(await methods.readTree(...args)),
        readCommit: async (...args) => decode(await methods.readCommit(...args)),
        readFile: async (...args) => decodeBlob(await methods.readFile(...args)),
        log: async (...args) => decode(await methods.log(...args)),
      };
    },
  };
}
