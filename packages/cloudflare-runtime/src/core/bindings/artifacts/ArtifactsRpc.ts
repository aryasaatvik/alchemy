import { RpcTarget } from "capnweb";

/**
 * Wire contract for a remote Artifacts binding.
 *
 * The edge Artifacts binding returns workerd RPC objects: a repository from
 * `get()` is a stub whose metadata fields are not readable as data, and result
 * records are passed by reference rather than copied. Cap'n Web cannot carry
 * either across the remote-binding hop, so the remote side
 * ({@link ArtifactsBindingProxy}) sends records as JSON strings and repository
 * metadata as a plain value, and the local wrapper (`artifacts.worker.ts`)
 * rebuilds the `Artifacts` surface user code expects.
 */

/** The by-value half of an `ArtifactsRepo`. */
export type ArtifactsRepositoryMetadata = ArtifactsRepoInfo;

/** Repository operations as the remote side exposes them; records are JSON. */
export interface ArtifactsRepositoryWireOperations {
  createToken(scope?: "write" | "read", ttl?: number): Promise<string>;
  listTokens(): Promise<string>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  fork(
    name: string,
    options?: Parameters<ArtifactsRepo["fork"]>[1],
  ): Promise<string>;
}

/** The own properties of an `ArtifactsError`, so it survives the hop. */
export type ArtifactsErrorWire = {
  readonly name: "ArtifactsError";
  readonly message: string;
  readonly code: ArtifactsErrorCode;
  readonly numericCode: number;
};

export type ArtifactsRepositoryMetadataResult =
  | { readonly ok: true; readonly metadata: ArtifactsRepositoryMetadata }
  | { readonly ok: false; readonly error: ArtifactsErrorWire };

const toJson = async (result: Promise<unknown>): Promise<string> =>
  JSON.stringify(await result);

const toArtifactsErrorWire = (error: unknown): ArtifactsErrorWire => {
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

/** A `list()` record; `remote` is typed absent but kept when present. */
type ListedRepository = Omit<ArtifactsRepoInfo, "remote"> &
  Partial<Pick<ArtifactsRepoInfo, "remote">>;

/** Remote-side methods of one repository handle. */
export class ArtifactsRepositoryMethods
  extends RpcTarget
  implements ArtifactsRepositoryWireOperations
{
  readonly #repository: ArtifactsRepo;

  constructor(repository: ArtifactsRepo) {
    super();
    this.#repository = repository;
  }

  createToken(scope?: "write" | "read", ttl?: number) {
    return toJson(this.#repository.createToken(scope, ttl));
  }

  listTokens() {
    return toJson(this.#repository.listTokens());
  }

  revokeToken(tokenOrId: string) {
    return this.#repository.revokeToken(tokenOrId);
  }

  fork(name: string, options?: Parameters<ArtifactsRepo["fork"]>[1]) {
    return toJson(this.#repository.fork(name, options));
  }
}

/**
 * Remote-side Cap'n Web target for an Artifacts binding.
 *
 * `getMetadata` reads the repository from `list()` because the handle from
 * `get()` exposes no metadata. List records omit `remote`, so it is rebuilt
 * from the account and namespace when absent. Failures return as a result value: a thrown
 * `ArtifactsError` loses its `code` and `numericCode` across the hop.
 */
export class ArtifactsBindingProxy extends RpcTarget {
  readonly #binding: Artifacts;
  readonly #accountId: string | undefined;
  readonly #namespace: string | undefined;

  constructor(binding: Artifacts, accountId?: string, namespace?: string) {
    super();
    this.#binding = binding;
    this.#accountId = accountId;
    this.#namespace = namespace;
  }

  create(name: string, options?: Parameters<Artifacts["create"]>[1]) {
    return toJson(this.#binding.create(name, options));
  }

  async getMetadata(name: string): Promise<ArtifactsRepositoryMetadataResult> {
    try {
      let cursor: string | undefined;
      let repository: ListedRepository | undefined;
      do {
        const page = JSON.parse(
          await toJson(this.#binding.list({ limit: 100, cursor })),
        ) as { repos: ListedRepository[]; cursor?: string };
        repository = page.repos.find((candidate) => candidate.name === name);
        cursor = page.cursor;
      } while (repository === undefined && cursor !== undefined);
      if (repository === undefined) {
        return {
          ok: false,
          error: {
            name: "ArtifactsError",
            message: `Repository not found: ${name}.`,
            code: "NOT_FOUND",
            numericCode: 10_001,
          },
        };
      }
      const remote =
        repository.remote ??
        (this.#accountId !== undefined && this.#namespace !== undefined
          ? `https://${this.#accountId}.artifacts.cloudflare.net/git/${encodeURIComponent(this.#namespace)}/${encodeURIComponent(name)}.git`
          : undefined);
      if (remote === undefined) {
        throw new Error(
          "Artifacts repository metadata requires account and namespace context.",
        );
      }
      return { ok: true, metadata: { ...repository, remote } };
    } catch (error) {
      return { ok: false, error: toArtifactsErrorWire(error) };
    }
  }

  async getMethods(name: string): Promise<ArtifactsRepositoryWireOperations> {
    return new ArtifactsRepositoryMethods(await this.#binding.get(name));
  }

  import(params: Parameters<Artifacts["import"]>[0]) {
    return toJson(this.#binding.import(params));
  }

  list(options?: Parameters<Artifacts["list"]>[0]) {
    return toJson(this.#binding.list(options));
  }

  delete(name: string): Promise<boolean> {
    return this.#binding.delete(name);
  }
}
