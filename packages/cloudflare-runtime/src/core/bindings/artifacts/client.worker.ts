import { newWebSocketRpcSession, type RpcPromise } from "capnweb";
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  artifactRpcErrorFields,
  emitArtifactDiagnostic,
  relayArtifactDiagnostics,
  type ArtifactsOperation,
} from "./ArtifactsDiagnostics.ts";
import type { ArtifactsRepositoryWireOperations } from "./ArtifactsRpc.ts";

interface Props {
  binding: string;
  artifactsNamespace: string;
}

/** Opens a Cap'n Web session for the Artifacts binding. */
type OpenArtifactsSession = () => Fetcher & Disposable;

/**
 * Run one operation on its own Cap'n Web session and close it afterwards.
 *
 * A session holds a WebSocket to the preview worker until its main stub is
 * disposed, so a session per operation keeps none open between calls, and a
 * dropped WebSocket fails only the operation in flight.
 */
const withArtifactsSession = async <A>(
  open: OpenArtifactsSession,
  name: ArtifactsOperation,
  operation: (stub: Fetcher) => Promise<A>,
): Promise<A> => {
  emitArtifactDiagnostic({ operation: name, stage: "session-open", outcome: "begin" });
  let stub: Fetcher & Disposable;
  try {
    // The stub opens asynchronously; the forwarder records the HTTP upgrade outcome.
    stub = open();
    emitArtifactDiagnostic({ operation: name, stage: "session-open", outcome: "success" });
  } catch (error) {
    emitArtifactDiagnostic({
      operation: name,
      stage: "session-open",
      outcome: "failure",
      transport: "rpc",
      ...artifactRpcErrorFields(error),
    });
    throw error;
  }
  try {
    emitArtifactDiagnostic({ operation: name, stage: "dispatch", outcome: "begin" });
    const result = operation(stub);
    emitArtifactDiagnostic({ operation: name, stage: "dispatch", outcome: "success" });
    return await result;
  } finally {
    emitArtifactDiagnostic({ operation: name, stage: "session-dispose", outcome: "begin" });
    try {
      stub[Symbol.dispose]();
      emitArtifactDiagnostic({ operation: name, stage: "session-dispose", outcome: "success" });
    } catch (error) {
      emitArtifactDiagnostic({
        operation: name,
        stage: "session-dispose",
        outcome: "failure",
        transport: "rpc",
        ...artifactRpcErrorFields(error),
      });
      // oxlint-disable-next-line no-unsafe-finally -- Preserve existing session-disposal error precedence.
      throw error;
    }
  }
};

const settleArtifacts = async <A>(
  name: ArtifactsOperation,
  operation: () => Promise<A>,
): Promise<A> => {
  try {
    const result = await operation();
    const received = relayArtifactDiagnostics(result);
    emitArtifactDiagnostic({
      operation: name,
      stage: "envelope",
      outcome: received ? "success" : "failure",
      ...(received ? {} : { transport: "envelope" as const }),
    });
    return result;
  } catch (error) {
    emitArtifactDiagnostic({
      operation: name,
      stage: "envelope",
      outcome: "failure",
      transport: "rpc",
      ...artifactRpcErrorFields(error),
    });
    throw error;
  }
};

const callArtifacts = (stub: Fetcher, name: string, args: Array<unknown>) =>
  (Reflect.get(stub, name) as (...args: Array<unknown>) => Promise<unknown>)(...args);

/**
 * Repository methods behind a workerd `RpcTarget`: a Cap'n Web stub cannot
 * cross workerd RPC to the local `artifacts.worker.ts` wrapper. Each method
 * resolves the repository on a session of its own, so a repository handle
 * outlives any one WebSocket. Records and error envelopes stay serialized until the local facade decodes them.
 */
class ArtifactsRepositoryMethodsBridge
  extends RpcTarget
  implements ArtifactsRepositoryWireOperations
{
  readonly #name: string;
  readonly #id: string;
  readonly #open: OpenArtifactsSession;

  constructor(name: string, id: string, open: OpenArtifactsSession) {
    super();
    this.#name = name;
    this.#id = id;
    this.#open = open;
  }

  #withMethods<A>(
    name: ArtifactsOperation,
    operation: (methods: ArtifactsRepositoryWireOperations) => Promise<A>,
  ): Promise<A> {
    return withArtifactsSession(this.#open, name, async (stub) => {
      // Keep the capability promise unresolved so its method shares the same RPC round trip.
      const methods = callArtifacts(stub, "getMethods", [
        this.#name,
        this.#id,
        true,
      ]) as RpcPromise<ArtifactsRepositoryWireOperations>;
      const dispose = methods[Symbol.dispose];
      using _lifetime = {
        [Symbol.dispose]: () => {
          emitArtifactDiagnostic({ operation: name, stage: "methods-dispose", outcome: "begin" });
          try {
            dispose.call(methods);
            emitArtifactDiagnostic({
              operation: name,
              stage: "methods-dispose",
              outcome: "success",
            });
          } catch (error) {
            emitArtifactDiagnostic({
              operation: name,
              stage: "methods-dispose",
              outcome: "failure",
              transport: "rpc",
              ...artifactRpcErrorFields(error),
            });
            throw error;
          }
        },
      };
      return await settleArtifacts(name, () => operation(methods));
    });
  }

  info() {
    return this.#withMethods("info", (methods) => methods.info());
  }
  createToken(...args: Parameters<ArtifactsRepo["createToken"]>) {
    return this.#withMethods("createToken", (methods) => methods.createToken(...args));
  }
  listTokens() {
    return this.#withMethods("listTokens", (methods) => methods.listTokens());
  }
  revokeToken(...args: Parameters<ArtifactsRepo["revokeToken"]>) {
    return this.#withMethods("revokeToken", (methods) => methods.revokeToken(...args));
  }
  fork(...args: Parameters<ArtifactsRepo["fork"]>) {
    return this.#withMethods("fork", (methods) => methods.fork(...args));
  }
  readBlob(...args: Parameters<ArtifactsRepo["readBlob"]>) {
    return this.#withMethods("readBlob", (methods) => methods.readBlob(...args));
  }
  readTree(...args: Parameters<ArtifactsRepo["readTree"]>) {
    return this.#withMethods("readTree", (methods) => methods.readTree(...args));
  }
  readCommit(...args: Parameters<ArtifactsRepo["readCommit"]>) {
    return this.#withMethods("readCommit", (methods) => methods.readCommit(...args));
  }
  readFile(...args: Parameters<ArtifactsRepo["readFile"]>) {
    return this.#withMethods("readFile", (methods) => methods.readFile(...args));
  }
  log(...args: Parameters<ArtifactsRepo["log"]>) {
    return this.#withMethods("log", (methods) => methods.log(...args));
  }
}

/** Client for the local Artifacts facade. The generic remote client stays independent. */
export default class ArtifactsClient extends WorkerEntrypoint<unknown, Props> {
  #open: OpenArtifactsSession = () => {
    const { binding, artifactsNamespace } = this.ctx.props;
    const url = new URL("ws://stub");
    url.searchParams.set("MF-Binding", binding);
    url.searchParams.set("MF-Artifacts-Namespace", artifactsNamespace);
    return newWebSocketRpcSession(url.href) as unknown as Fetcher & Disposable;
  };

  #call(operation: ArtifactsOperation, method: string, args: Array<unknown>) {
    return withArtifactsSession(this.#open, operation, (stub) =>
      settleArtifacts(operation, () => callArtifacts(stub, method, args)),
    );
  }

  create(...args: Parameters<Artifacts["create"]>) {
    return this.#call("create", "create", args);
  }

  import(...args: Parameters<Artifacts["import"]>) {
    return this.#call("import", "import", args);
  }

  list(...args: Parameters<Artifacts["list"]>) {
    return this.#call("list", "list", args);
  }

  delete(...args: Parameters<Artifacts["delete"]>) {
    return this.#call("delete", "delete", args);
  }

  artifactsGetMetadata(name: string) {
    return this.#call("metadata", "getMetadata", [name, true]);
  }

  artifactsGetMethods(name: string, id: string) {
    return new ArtifactsRepositoryMethodsBridge(name, id, this.#open);
  }
}
