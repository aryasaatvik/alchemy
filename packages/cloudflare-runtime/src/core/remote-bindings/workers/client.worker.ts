import { newWebSocketRpcSession, type RpcPromise } from "capnweb";
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  emitArtifactDiagnostic,
  relayArtifactDiagnostics,
  type ArtifactsOperation,
} from "../../bindings/artifacts/ArtifactsDiagnostics.ts";
import type {
  ArtifactsRepositoryMetadataResult,
  ArtifactsRepositoryWireOperations,
} from "../../bindings/artifacts/ArtifactsRpc.ts";

interface Props {
  binding: string;
  /** Identifies Artifacts bindings so their native capabilities use the typed bridge. */
  artifactsNamespace?: string;
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
  readonly #open: OpenArtifactsSession;

  constructor(name: string, open: OpenArtifactsSession) {
    super();
    this.#name = name;
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

/**
 * The operations the local Artifacts wrapper calls, adapted from the remote
 * `ArtifactsBindingProxy`. Every result is awaited here so no Cap'n Web
 * promise crosses workerd RPC.
 */
const artifactsOperation = (open: OpenArtifactsSession, prop: string | symbol) => {
  const call = (operation: ArtifactsOperation, name: string, args: Array<unknown>) =>
    withArtifactsSession(open, operation, (stub) =>
      settleArtifacts(operation, () => callArtifacts(stub, name, args)),
    );
  switch (prop) {
    case "create":
    case "import":
    case "list":
    case "delete":
      return async (...args: Array<unknown>) => await call(prop, prop, args);
    case "artifactsGetMetadata":
      return async (name: string) =>
        (await call("metadata", "getMetadata", [name, true])) as ArtifactsRepositoryMetadataResult;
    case "artifactsGetMethods":
      return async (name: string) => new ArtifactsRepositoryMethodsBridge(name, open);
    default:
      return undefined;
  }
};

/** Generic remote proxy client for bindings. */
export default class Client extends WorkerEntrypoint<unknown, Props> {
  fetch(request: Request): Promise<Response> {
    return makeFetch(this.ctx.props.binding)(request);
  }

  constructor(ctx: ExecutionContext<Props>, env: unknown) {
    super(ctx, env);
    const { binding, artifactsNamespace } = ctx.props;
    let stub: Fetcher | undefined;
    const getStub = () => (stub ??= makeRemoteProxyStub(binding));

    return new Proxy(this, {
      get: (target, prop) => {
        if (artifactsNamespace !== undefined) {
          const operation = artifactsOperation(
            () =>
              makeRemoteProxyStub(binding, {
                "MF-Artifacts-Namespace": artifactsNamespace,
              }),
            prop,
          );
          if (operation) return operation;
        }
        if (Reflect.has(target, prop)) {
          return Reflect.get(target, prop);
        }
        // Startup probes and fetch-only bindings must not open an RPC session.
        // Cap'n Web properties support both invocation and promise resolution.
        let rpcProperty: unknown;
        let resolved = false;
        const getRpcProperty = () => {
          if (!resolved) {
            rpcProperty = Reflect.get(getStub(), prop);
            resolved = true;
          }
          return rpcProperty;
        };
        return new Proxy(
          (...args: Array<unknown>) => {
            const method = getRpcProperty() as (...args: Array<unknown>) => unknown;
            return Reflect.apply(method, undefined, args);
          },
          {
            get: (_target, key) => Reflect.get(getRpcProperty() as object, key),
          },
        );
      },
    });
  }
}

/** Headers sent alongside proxy requests to provide additional context. */
export type ProxyMetadata = {
  "MF-Dispatch-Namespace-Options"?: string;
  "MF-Artifacts-Namespace"?: string;
};

export function makeFetch(bindingName: string, extraHeaders?: Headers) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);

    const proxiedHeaders = new Headers(extraHeaders);
    for (const [name, value] of request.headers) {
      // The `Upgrade` header needs to be special-cased to prevent:
      //   TypeError: Worker tried to return a WebSocket in a response to a request which did not contain the header "Upgrade: websocket"
      // `MF-Dispatch-Namespace-Options` is consumed by the remote bindings
      // preview endpoint and must be forwarded verbatim.
      if (name === "upgrade" || name === "mf-dispatch-namespace-options") {
        proxiedHeaders.set(name, value);
      } else {
        proxiedHeaders.set(`MF-Header-${name}`, value);
      }
    }
    proxiedHeaders.set("MF-URL", request.url);
    proxiedHeaders.set("MF-Binding", bindingName);
    const req = new Request(request, {
      headers: proxiedHeaders,
    });

    const response = await fetch("http://stub", req);
    return response;
  };
}

/**
 * Create a remote proxy stub that proxies to a remote binding via capnweb.
 *
 * Intercepts `.fetch()` to use plain HTTP; forwards other accesses to capnweb.
 */
export function makeRemoteProxyStub(
  bindingName: string,
  metadata?: ProxyMetadata,
): Fetcher & Disposable {
  const url = new URL("ws://stub");
  url.searchParams.set("MF-Binding", bindingName);
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
  }

  type ProxiedService = Omit<Service, "connect" | "fetch"> & {
    fetch: typeof fetch;
    connect: never;
  };

  const stub = newWebSocketRpcSession(url.href) as unknown as ProxiedService;

  const headers = metadata
    ? new Headers(
        Object.entries(metadata).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
    : undefined;

  return new Proxy<ProxiedService>(stub, {
    get(_, p) {
      if (p === "fetch") {
        return makeFetch(bindingName, headers);
      }
      return Reflect.get(stub, p);
    },
  }) as unknown as Fetcher & Disposable;
}
