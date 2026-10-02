// Extensions must bundle to exactly one module, so this file only imports
// types (erased at build time).
import type {
  ArtifactsRepositoryMetadataResult,
  ArtifactsRepositoryWireOperations,
} from "./ArtifactsRpc.ts";

/**
 * The remote-bindings client for an Artifacts binding. Record results arrive
 * parsed; see `client.worker.ts`.
 */
interface ProxyClient extends Omit<Artifacts, "get"> {
  artifactsGetMetadata(
    name: string,
  ): Promise<ArtifactsRepositoryMetadataResult>;
  artifactsGetMethods(
    name: string,
  ): Promise<ArtifactsRepositoryParsedOperations>;
}

type ArtifactsRepositoryParsedOperations = Pick<
  ArtifactsRepo,
  keyof ArtifactsRepositoryWireOperations
>;

interface Env {
  proxyClient: ProxyClient;
}

/**
 * Wrap the remote-bindings client in the `Artifacts` surface. `get()`
 * rebuilds an `ArtifactsRepo` from its metadata and a methods stub, and
 * rethrows remote failures as errors carrying `code` and `numericCode`.
 */
export default function makeBinding(env: Env): Artifacts {
  return {
    create: (name, options) => env.proxyClient.create(name, options),
    async get(name) {
      const result = await env.proxyClient.artifactsGetMetadata(name);
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), result.error);
      }
      const methods = await env.proxyClient.artifactsGetMethods(name);
      return {
        ...result.metadata,
        createToken: (scope, ttl) => methods.createToken(scope, ttl),
        listTokens: () => methods.listTokens(),
        revokeToken: (tokenOrId) => methods.revokeToken(tokenOrId),
        fork: (forkName, options) => methods.fork(forkName, options),
      };
    },
    import: (params) => env.proxyClient.import(params),
    list: (options) => env.proxyClient.list(options),
    delete: (name) => env.proxyClient.delete(name),
  };
}
