import { RpcTarget } from "capnweb";

export type ArtifactsRepositoryMetadata = Pick<
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

export interface ArtifactsRepositoryOperations {
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

export class ArtifactsRepositoryMethods
  extends RpcTarget
  implements ArtifactsRepositoryOperations
{
  readonly #repository: ArtifactsRepo;

  constructor(repository: ArtifactsRepo) {
    super();
    this.#repository = repository;
  }

  createToken(scope?: "write" | "read", ttl?: number) {
    return this.#repository.createToken(scope, ttl);
  }

  listTokens() {
    return this.#repository.listTokens();
  }

  revokeToken(tokenOrId: string) {
    return this.#repository.revokeToken(tokenOrId);
  }

  fork(name: string, options?: Parameters<ArtifactsRepo["fork"]>[1]) {
    return this.#repository.fork(name, options);
  }
}

export type ArtifactsRepositoryWire = {
  readonly metadata: ArtifactsRepositoryMetadata;
  readonly methods: ArtifactsRepositoryOperations;
};

export const exposeArtifactsRepository = (
  repository: ArtifactsRepo,
): ArtifactsRepositoryWire => ({
  metadata: {
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
  },
  methods: new ArtifactsRepositoryMethods(repository),
});

export const hydrateArtifactsRepository = ({
  metadata,
  methods,
}: ArtifactsRepositoryWire): ArtifactsRepo => ({
  ...metadata,
  createToken: (scope, ttl) => methods.createToken(scope, ttl),
  listTokens: () => methods.listTokens(),
  revokeToken: (tokenOrId) => methods.revokeToken(tokenOrId),
  fork: (name, options) => methods.fork(name, options),
});

export class ArtifactsBindingProxy extends RpcTarget {
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

  async get(name: string): Promise<ArtifactsRepositoryWire> {
    return exposeArtifactsRepository(await this.#binding.get(name));
  }

  async getMetadata(name: string): Promise<ArtifactsRepositoryMetadata> {
    let cursor: string | undefined;
    do {
      const page = await this.#binding.list({ limit: 200, cursor });
      const repository = (
        page.repos as Array<ArtifactsRepositoryMetadata>
      ).find((candidate) => candidate.name === name);
      if (repository) return repository;
      cursor = page.cursor;
    } while (cursor);
    throw new Error(`Artifacts repository '${name}' was not found`);
  }

  async getMethods(name: string): Promise<ArtifactsRepositoryOperations> {
    return new ArtifactsRepositoryMethods(await this.#binding.get(name));
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
