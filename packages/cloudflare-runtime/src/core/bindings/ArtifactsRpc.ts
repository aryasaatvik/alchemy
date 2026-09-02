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

export interface ArtifactsRepositoryWireOperations {
  createToken(scope?: "write" | "read", ttl?: number): Promise<string>;
  listTokens(): Promise<string>;
  revokeToken(tokenOrId: string): ReturnType<ArtifactsRepo["revokeToken"]>;
  fork(
    name: string,
    options?: Parameters<ArtifactsRepo["fork"]>[1],
  ): Promise<string>;
}

export class ArtifactsRepositoryMethods
  extends RpcTarget
  implements ArtifactsRepositoryWireOperations
{
  readonly #repository: ArtifactsRepo;

  constructor(repository: ArtifactsRepo) {
    super();
    this.#repository = repository;
  }

  async createToken(scope?: "write" | "read", ttl?: number) {
    return JSON.stringify(await this.#repository.createToken(scope, ttl));
  }

  async listTokens() {
    return JSON.stringify(await this.#repository.listTokens());
  }

  revokeToken(tokenOrId: string) {
    return this.#repository.revokeToken(tokenOrId);
  }

  async fork(name: string, options?: Parameters<ArtifactsRepo["fork"]>[1]) {
    return JSON.stringify(await this.#repository.fork(name, options));
  }
}

export type ArtifactsRepositoryWire = {
  readonly metadata: ArtifactsRepositoryMetadata;
  readonly methods: ArtifactsRepositoryWireOperations;
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

const serializeArtifactsRepositoryMetadata = (
  repository: ArtifactsRepo,
): ArtifactsRepositoryMetadata =>
  JSON.parse(JSON.stringify(repository)) as ArtifactsRepositoryMetadata;

export const hydrateArtifactsRepository = ({
  metadata,
  methods,
}: ArtifactsRepositoryWire): ArtifactsRepo => ({
  ...metadata,
  createToken: async (scope, ttl) => JSON.parse(await methods.createToken(scope, ttl)),
  listTokens: async () => JSON.parse(await methods.listTokens()),
  revokeToken: (tokenOrId) => methods.revokeToken(tokenOrId),
  fork: async (name, options) => JSON.parse(await methods.fork(name, options)),
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
  ): Promise<string> {
    return JSON.stringify(await this.#binding.create(name, options));
  }

  async get(name: string): Promise<ArtifactsRepositoryWire> {
    const repository = await this.#binding.get(name);
    return {
      metadata: serializeArtifactsRepositoryMetadata(repository),
      methods: new ArtifactsRepositoryMethods(repository),
    };
  }

  async getMetadata(name: string): Promise<ArtifactsRepositoryMetadataResult> {
    try {
      return {
        ok: true,
        metadata: serializeArtifactsRepositoryMetadata(
          await this.#binding.get(name),
        ),
      };
    } catch (error) {
      return { ok: false, error: exposeArtifactsError(error) };
    }
  }

  async getMethods(name: string): Promise<ArtifactsRepositoryWireOperations> {
    return new ArtifactsRepositoryMethods(await this.#binding.get(name));
  }

  async import(
    params: Parameters<Artifacts["import"]>[0],
  ): Promise<string> {
    return JSON.stringify(await this.#binding.import(params));
  }

  async list(
    options?: Parameters<Artifacts["list"]>[0],
  ): Promise<string> {
    return JSON.stringify(await this.#binding.list(options));
  }

  delete(name: string): Promise<boolean> {
    return this.#binding.delete(name);
  }
}
