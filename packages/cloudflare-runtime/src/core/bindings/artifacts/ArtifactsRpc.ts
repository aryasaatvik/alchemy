import { RpcTarget } from "capnweb";
import { ArtifactsDiagnostics, type ArtifactsOperation } from "./ArtifactsDiagnostics.ts";

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

const toJson = async (
  operation: () => Promise<unknown>,
  trace?: ArtifactsDiagnostics,
): Promise<string> => {
  let serializing = false;
  try {
    const value = await operation();
    serializing = true;
    trace?.record("serialize", "begin");
    const json = JSON.stringify({ ok: true, value });
    trace?.record("serialize", "success");
    // Append after business serialization: sidecar inspection cannot touch native values.
    return trace
      ? json.slice(0, -1) + ',"diagnostics":' + JSON.stringify(trace.events) + "}"
      : json;
  } catch (error) {
    if (serializing) trace?.record("serialize", "failure", undefined, "bridge-fallback");
    const wire = toArtifactsErrorWire(error, trace);
    return JSON.stringify({
      ok: false,
      error: wire,
      ...(trace ? { diagnostics: trace.events } : {}),
    });
  }
};

const toArtifactsErrorWire = (error: unknown, trace?: ArtifactsDiagnostics): ArtifactsErrorWire => {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "numericCode" in error &&
    typeof error.numericCode === "number"
  ) {
    const wire: ArtifactsErrorWire = {
      name: "ArtifactsError",
      message: error.message,
      code: error.code as ArtifactsErrorCode,
      numericCode: error.numericCode,
    };
    trace?.record("envelope", "failure", wire, "native");
    return wire;
  }
  const wire: ArtifactsErrorWire = {
    name: "ArtifactsError",
    message: error instanceof Error ? error.message : "Unknown Artifacts error",
    code: "INTERNAL_ERROR",
    numericCode: 0,
  };
  trace?.record("envelope", "failure", wire, "bridge-fallback");
  return wire;
};

/** A fresh native capability is disposed before its operation returns. */
export class ArtifactsRepositoryMethods
  extends RpcTarget
  implements ArtifactsRepositoryWireOperations
{
  readonly #binding: Artifacts;
  readonly #name: string;
  readonly #diagnostics: boolean;

  constructor(binding: Artifacts, name: string, diagnostics = false) {
    super();
    this.#binding = binding;
    this.#name = name;
    this.#diagnostics = diagnostics;
  }

  #use(name: ArtifactsOperation, operation: (repository: ArtifactsRepo) => Promise<unknown>) {
    const trace = this.#diagnostics ? new ArtifactsDiagnostics(name) : undefined;
    return toJson(async () => {
      const repository = await (trace
        ? trace.run("native-get", () => this.#binding.get(this.#name))
        : this.#binding.get(this.#name));
      using _lifetime = trace ? trace.lifetime(repository) : repository;
      return await (trace
        ? trace.run(name === "createToken" ? "native-createToken" : "native-call", () =>
            operation(repository),
          )
        : operation(repository));
    }, trace);
  }

  #blob(name: ArtifactsOperation, operation: (repository: ArtifactsRepo) => Promise<Blob | null>) {
    return this.#use(name, async (repository): Promise<ArtifactsBlobWire | null> => {
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
    return this.#use("info", (repository) => repository.info());
  }
  createToken(...args: Parameters<ArtifactsRepo["createToken"]>) {
    return this.#use("createToken", (repository) => repository.createToken(...args));
  }
  listTokens() {
    return this.#use("listTokens", (repository) => repository.listTokens());
  }
  revokeToken(...args: Parameters<ArtifactsRepo["revokeToken"]>) {
    return this.#use("revokeToken", (repository) => repository.revokeToken(...args));
  }
  fork(...args: Parameters<ArtifactsRepo["fork"]>) {
    return this.#use("fork", (repository) => repository.fork(...args));
  }
  readBlob(...args: Parameters<ArtifactsRepo["readBlob"]>) {
    return this.#blob("readBlob", (repository) => repository.readBlob(...args));
  }
  readTree(...args: Parameters<ArtifactsRepo["readTree"]>) {
    return this.#use("readTree", (repository) => repository.readTree(...args));
  }
  readCommit(...args: Parameters<ArtifactsRepo["readCommit"]>) {
    return this.#use("readCommit", (repository) => repository.readCommit(...args));
  }
  readFile(...args: Parameters<ArtifactsRepo["readFile"]>) {
    return this.#blob("readFile", (repository) => repository.readFile(...args));
  }
  log(...args: Parameters<ArtifactsRepo["log"]>) {
    return this.#use("log", (repository) => repository.log(...args));
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

  async getMetadata(name: string, diagnostics = false): Promise<ArtifactsRepositoryMetadataResult> {
    const trace = diagnostics ? new ArtifactsDiagnostics("metadata") : undefined;
    try {
      const repository = await (trace
        ? trace.run("native-get", () => this.#binding.get(name))
        : this.#binding.get(name));
      using _lifetime = trace ? trace.lifetime(repository) : repository;
      const info = await (trace
        ? trace.run("native-call", () => repository.info())
        : repository.info());
      const metadata = JSON.parse(JSON.stringify(info));
      return { ok: true, metadata, ...(trace ? { diagnostics: trace.events } : {}) };
    } catch (error) {
      const wire = toArtifactsErrorWire(error, trace);
      return { ok: false, error: wire, ...(trace ? { diagnostics: trace.events } : {}) };
    }
  }

  async getMethods(name: string, diagnostics = false): Promise<ArtifactsRepositoryWireOperations> {
    return new ArtifactsRepositoryMethods(this.#binding, name, diagnostics);
  }
}
