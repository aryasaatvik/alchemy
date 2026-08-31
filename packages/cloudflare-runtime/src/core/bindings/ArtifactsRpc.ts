import { RpcTarget } from "capnweb";

export const exposeArtifactsRepository = (
  repository: ArtifactsRepo,
): ArtifactsRepo => ({
  id: repository.id,
  name: repository.name,
  description: repository.description,
  defaultBranch: repository.defaultBranch,
  createdAt: repository.createdAt,
  updatedAt: repository.updatedAt,
  lastPushAt: repository.lastPushAt,
  source: repository.source,
  readOnly: repository.readOnly,
  remote: repository.remote,
  createToken: (scope, ttl) => repository.createToken(scope, ttl),
  listTokens: () => repository.listTokens(),
  revokeToken: (tokenOrId) => repository.revokeToken(tokenOrId),
  fork: (name, options) => repository.fork(name, options),
});

export class ArtifactsBindingProxy extends RpcTarget implements Artifacts {
  readonly #binding: Artifacts;

  constructor(binding: Artifacts) {
    super();
    this.#binding = binding;
  }

  create(
    name: string,
    options?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactsCreateRepoResult> {
    return this.#binding.create(name, options);
  }

  async get(name: string): Promise<ArtifactsRepo> {
    return exposeArtifactsRepository(await this.#binding.get(name));
  }

  import(
    params: Parameters<Artifacts["import"]>[0],
  ): Promise<ArtifactsCreateRepoResult> {
    return this.#binding.import(params);
  }

  list(
    options?: Parameters<Artifacts["list"]>[0],
  ): Promise<ArtifactsRepoListResult> {
    return this.#binding.list(options);
  }

  delete(name: string): Promise<boolean> {
    return this.#binding.delete(name);
  }
}
