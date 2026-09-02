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

const exposeCreateRepositoryResult = (
  result: ArtifactsCreateRepoResult,
): ArtifactsCreateRepoResult => ({
  id: result.id,
  name: result.name,
  description: result.description,
  defaultBranch: result.defaultBranch,
  remote: result.remote,
  token: result.token,
  tokenExpiresAt: result.tokenExpiresAt,
});

const exposeCreateTokenResult = (
  result: ArtifactsCreateTokenResult,
): ArtifactsCreateTokenResult => ({
  id: result.id,
  plaintext: result.plaintext,
  scope: result.scope,
  expiresAt: result.expiresAt,
});

const exposeTokenListResult = (
  result: ArtifactsTokenListResult,
): ArtifactsTokenListResult => ({
  tokens: result.tokens.map((token) => ({
    id: token.id,
    scope: token.scope,
    state: token.state,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
  })),
  total: result.total,
});

const exposeRepositoryListResult = (
  result: ArtifactsRepoListResult,
): ArtifactsRepoListResult => ({
  repos: result.repos.map((repository) => ({
    id: repository.id,
    name: repository.name,
    description: repository.description,
    defaultBranch: repository.defaultBranch,
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
    lastPushAt: repository.lastPushAt,
    source: repository.source,
    readOnly: repository.readOnly,
  })),
  total: result.total,
  ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
});

export class ArtifactsRepositoryMethods
  extends RpcTarget
  implements ArtifactsRepositoryOperations
{
  readonly #repository: ArtifactsRepo;

  constructor(repository: ArtifactsRepo) {
    super();
    this.#repository = repository;
  }

  async createToken(scope?: "write" | "read", ttl?: number) {
    return exposeCreateTokenResult(
      await this.#repository.createToken(scope, ttl),
    );
  }

  async listTokens() {
    return exposeTokenListResult(await this.#repository.listTokens());
  }

  revokeToken(tokenOrId: string) {
    return this.#repository.revokeToken(tokenOrId);
  }

  async fork(name: string, options?: Parameters<ArtifactsRepo["fork"]>[1]) {
    return exposeCreateRepositoryResult(
      await this.#repository.fork(name, options),
    );
  }
}

export type ArtifactsRepositoryWire = {
  readonly metadata: ArtifactsRepositoryMetadata;
  readonly methods: ArtifactsRepositoryOperations;
};

export type ArtifactsErrorWire = {
  readonly name: "ArtifactsError";
  readonly message: string;
  readonly code: ArtifactsErrorCode;
  readonly numericCode: number;
};

export type ArtifactsRepositoryMetadataResult =
  | { readonly ok: true; readonly metadata: ArtifactsRepositoryMetadata }
  | { readonly ok: false; readonly error: ArtifactsErrorWire };

const exposeArtifactsError = (error: unknown): ArtifactsErrorWire => {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "numericCode" in error &&
    typeof error.numericCode === "number"
  ) {
    return {
      name: "ArtifactsError",
      message: error.message,
      code: error.code as ArtifactsErrorCode,
      numericCode: error.numericCode,
    };
  }
  return {
    name: "ArtifactsError",
    message: error instanceof Error ? error.message : "Unknown Artifacts error",
    code: "INTERNAL_ERROR",
    numericCode: 0,
  };
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

  async create(
    name: string,
    options?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactsCreateRepoResult> {
    return exposeCreateRepositoryResult(
      await this.#binding.create(name, options),
    );
  }

  async get(name: string): Promise<ArtifactsRepositoryWire> {
    return exposeArtifactsRepository(await this.#binding.get(name));
  }

  async getMetadata(name: string): Promise<ArtifactsRepositoryMetadataResult> {
    try {
      return {
        ok: true,
        metadata: exposeArtifactsRepository(await this.#binding.get(name))
          .metadata,
      };
    } catch (error) {
      return { ok: false, error: exposeArtifactsError(error) };
    }
  }

  async getMethods(name: string): Promise<ArtifactsRepositoryOperations> {
    return new ArtifactsRepositoryMethods(await this.#binding.get(name));
  }

  async import(
    params: Parameters<Artifacts["import"]>[0],
  ): Promise<ArtifactsCreateRepoResult> {
    return exposeCreateRepositoryResult(await this.#binding.import(params));
  }

  async list(
    options?: Parameters<Artifacts["list"]>[0],
  ): Promise<ArtifactsRepoListResult> {
    return exposeRepositoryListResult(await this.#binding.list(options));
  }

  delete(name: string): Promise<boolean> {
    return this.#binding.delete(name);
  }
}
