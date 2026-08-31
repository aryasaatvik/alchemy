import {
  hydrateArtifactsRepository,
  type ArtifactsRepositoryWire,
} from "./ArtifactsRpc.ts";

interface Env {
  proxyClient: Omit<Artifacts, "get"> & {
    get(name: string): Promise<ArtifactsRepositoryWire>;
  };
}

export default function makeBinding(env: Env): Artifacts {
  return {
    create: (name, options) => env.proxyClient.create(name, options),
    async get(name) {
      return hydrateArtifactsRepository(await env.proxyClient.get(name));
    },
    import: (params) => env.proxyClient.import(params),
    list: (options) => env.proxyClient.list(options),
    delete: (name) => env.proxyClient.delete(name),
  };
}
