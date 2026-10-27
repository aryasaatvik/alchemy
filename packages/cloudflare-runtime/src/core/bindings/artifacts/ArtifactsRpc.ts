import { RpcTarget } from "capnweb";

/**
 * Wire contract for a remote Artifacts binding.
 *
 * The edge Artifacts binding returns workerd RPC objects: a repository from
 * `get()` is a capability with fresh metadata available through `info()`.
 * Its records and Blobs arrive by reference, so the remote side serializes
 * them and their error codes before crossing Cap'n Web. The local facade
 * reconstructs the complete native API and native Blob values.
 */

/** The by-value half of an `ArtifactsRepo`. */
export type ArtifactsRepositoryMetadata = ArtifactsRepoInfo;

/** Every native repository operation is carried as a JSON result envelope. */
export type ArtifactsRepositoryWireOperations = {
  [Method in Exclude<keyof ArtifactsRepo, typeof Symbol.dispose>]: (
    ...args: Parameters<ArtifactsRepo[Method]>
  ) => Promise<string>;
};

/** Blob bytes cross Cap'n Web as data rather than an RPC capability. */
export interface ArtifactsBlobWire {
  base64: string;
  type: string;
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

const toJson = async (operation: () => Promise<unknown>): Promise<string> => {
  try {
    return JSON.stringify({ ok: true, value: await operation() });
  } catch (error) {
    return JSON.stringify({ ok: false, error: toArtifactsErrorWire(error) });
  }
};

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

/** A fresh native capability is disposed before its operation returns. */
export class ArtifactsRepositoryMethods
  extends RpcTarget
  implements ArtifactsRepositoryWireOperations
{
  readonly #binding: Artifacts;
  readonly #name: string;

  constructor(binding: Artifacts, name: string) {
    super();
    this.#binding = binding;
    this.#name = name;
  }

  #use(operation: (repository: ArtifactsRepo) => Promise<unknown>) {
    return toJson(async () => {
      using repository = await this.#binding.get(this.#name);
      return await operation(repository);
    });
  }

  #blob(operation: (repository: ArtifactsRepo) => Promise<Blob | null>) {
    return this.#use(async (repository): Promise<ArtifactsBlobWire | null> => {
      const blob = await operation(repository);
      if (blob === null) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const chunks: string[] = [];
      // Chunk conversion avoids spreading a large blob onto the JS call stack.
      for (let offset = 0; offset < bytes.length; offset += 32_768) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
      }
      return { base64: btoa(chunks.join("")), type: blob.type };
    });
  }

  info() {
    return this.#use((repository) => repository.info());
  }
  createToken(...args: Parameters<ArtifactsRepo["createToken"]>) {
    return this.#use((repository) => repository.createToken(...args));
  }
  listTokens() {
    return this.#use((repository) => repository.listTokens());
  }
  revokeToken(...args: Parameters<ArtifactsRepo["revokeToken"]>) {
    return this.#use((repository) => repository.revokeToken(...args));
  }
  fork(...args: Parameters<ArtifactsRepo["fork"]>) {
    return this.#use((repository) => repository.fork(...args));
  }
  readBlob(...args: Parameters<ArtifactsRepo["readBlob"]>) {
    return this.#blob((repository) => repository.readBlob(...args));
  }
  readTree(...args: Parameters<ArtifactsRepo["readTree"]>) {
    return this.#use((repository) => repository.readTree(...args));
  }
  readCommit(...args: Parameters<ArtifactsRepo["readCommit"]>) {
    return this.#use((repository) => repository.readCommit(...args));
  }
  readFile(...args: Parameters<ArtifactsRepo["readFile"]>) {
    return this.#blob((repository) => repository.readFile(...args));
  }
  log(...args: Parameters<ArtifactsRepo["log"]>) {
    return this.#use((repository) => repository.log(...args));
  }
}

/** Remote target for one Artifacts namespace; native records travel by value. */
export class ArtifactsBindingProxy extends RpcTarget {
  readonly #binding: Artifacts;

  constructor(binding: Artifacts) {
    super();
    this.#binding = binding;
  }

  create(...args: Parameters<Artifacts["create"]>) {
    return toJson(() => this.#binding.create(...args));
  }
  import(...args: Parameters<Artifacts["import"]>) {
    return toJson(() => this.#binding.import(...args));
  }
  list(...args: Parameters<Artifacts["list"]>) {
    return toJson(() => this.#binding.list(...args));
  }
  delete(...args: Parameters<Artifacts["delete"]>) {
    return toJson(() => this.#binding.delete(...args));
  }

  async getMetadata(name: string): Promise<ArtifactsRepositoryMetadataResult> {
    try {
      using repository = await this.#binding.get(name);
      const metadata = JSON.parse(JSON.stringify(await repository.info()));
      return { ok: true, metadata };
    } catch (error) {
      return { ok: false, error: toArtifactsErrorWire(error) };
    }
  }

  async getMethods(name: string): Promise<ArtifactsRepositoryWireOperations> {
    return new ArtifactsRepositoryMethods(this.#binding, name);
  }
}
