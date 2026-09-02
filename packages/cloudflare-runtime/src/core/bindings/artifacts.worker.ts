type RepositoryMetadata = Pick<
  ArtifactsRepo,
  | "id"
  | "name"
  | "description"
  | "defaultBranch"
  | "createdAt"
  | "updatedAt"
  | "lastPushAt"
  | "source"
  | "readOnly"
  | "remote"
>;

interface RepositoryMethods {
  createToken(
    scope?: "write" | "read",
    ttl?: number,
  ): ReturnType<ArtifactsRepo["createToken"]>;
  listTokens(): ReturnType<ArtifactsRepo["listTokens"]>;
  revokeToken(tokenOrId: string): ReturnType<ArtifactsRepo["revokeToken"]>;
  fork(
    name: string,
    options?: Parameters<ArtifactsRepo["fork"]>[1],
  ): ReturnType<ArtifactsRepo["fork"]>;
}

interface RepositoryWire {
  readonly metadata: RepositoryMetadata;
  readonly methods: RepositoryMethods;
}

interface Env {
  proxyClient: Omit<Artifacts, "get"> & {
    artifactsGetMetadata(
      name: string,
    ): Promise<ArtifactsRepositoryMetadataResult>;
    artifactsGetMethods(name: string): Promise<RepositoryMethods>;
  };
}

const hydrateRepository = ({
  metadata,
  methods,
}: RepositoryWire): ArtifactsRepo => ({
  ...metadata,
  createToken: (scope, ttl) => methods.createToken(scope, ttl),
  listTokens: () => methods.listTokens(),
  revokeToken: (tokenOrId) => methods.revokeToken(tokenOrId),
  fork: (name, options) => methods.fork(name, options),
});

export default function makeBinding(env: Env): Artifacts {
  return {
    create: (name, options) => env.proxyClient.create(name, options),
    async get(name) {
      const result = await env.proxyClient.artifactsGetMetadata(name);
      if (!result.ok) throw hydrateArtifactsError(result.error);
      const methods = await env.proxyClient.artifactsGetMethods(name);
      return hydrateRepository({ metadata: result.metadata, methods });
    },
    import: (params) => env.proxyClient.import(params),
    list: (options) => env.proxyClient.list(options),
    delete: (name) => env.proxyClient.delete(name),
  };
}
import {
  hydrateArtifactsError,
  type ArtifactsRepositoryMetadataResult,
} from "./ArtifactsRpc.ts";
