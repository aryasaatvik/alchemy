import { newWebSocketRpcSession } from "capnweb";
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ArtifactsRepositoryMetadataResult,
  ArtifactsRepositoryWireOperations,
} from "../../bindings/artifacts/ArtifactsRpc.ts";

interface Props {
  binding: string;
  /** Set for Artifacts bindings; the remote worker rebuilds Git remotes from it. */
  artifactsNamespace?: string;
}

/**
 * Repository methods behind a workerd `RpcTarget`: a Cap'n Web stub cannot
 * cross workerd RPC to the local `artifacts.worker.ts` wrapper. Records arrive
 * as JSON and are parsed here.
 */
class ArtifactsRepositoryMethodsBridge extends RpcTarget {
  readonly #methods: ArtifactsRepositoryWireOperations;

  constructor(methods: ArtifactsRepositoryWireOperations) {
    super();
    this.#methods = methods;
  }

  async createToken(scope?: "write" | "read", ttl?: number) {
    return JSON.parse(await this.#methods.createToken(scope, ttl));
  }

  async listTokens() {
    return JSON.parse(await this.#methods.listTokens());
  }

  async revokeToken(tokenOrId: string) {
    return await this.#methods.revokeToken(tokenOrId);
  }

  async fork(name: string, options?: Parameters<ArtifactsRepo["fork"]>[1]) {
    return JSON.parse(await this.#methods.fork(name, options));
  }
}

/**
 * The operations the local Artifacts wrapper calls, adapted from the remote
 * `ArtifactsBindingProxy`. Every result is awaited here so no Cap'n Web
 * promise crosses workerd RPC.
 */
const artifactsOperation = (getStub: () => Fetcher, prop: string | symbol) => {
  const call = (name: string, args: Array<unknown>) =>
    (Reflect.get(getStub(), name) as (...args: Array<unknown>) => unknown)(
      ...args,
    );
  switch (prop) {
    case "create":
    case "import":
    case "list":
      return async (...args: Array<unknown>) =>
        JSON.parse((await call(prop, args)) as string);
    case "delete":
      return async (...args: Array<unknown>) => await call(prop, args);
    case "artifactsGetMetadata":
      return async (name: string) =>
        (await call("getMetadata", [
          name,
        ])) as ArtifactsRepositoryMetadataResult;
    case "artifactsGetMethods":
      return async (name: string) =>
        new ArtifactsRepositoryMethodsBridge(
          (await call("getMethods", [
            name,
          ])) as ArtifactsRepositoryWireOperations,
        );
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
    const getStub = () =>
      (stub ??= makeRemoteProxyStub(
        binding,
        artifactsNamespace === undefined
          ? undefined
          : { "MF-Artifacts-Namespace": artifactsNamespace },
      ));

    return new Proxy(this, {
      get: (target, prop) => {
        if (artifactsNamespace !== undefined) {
          const operation = artifactsOperation(getStub, prop);
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
            const method = getRpcProperty() as (
              ...args: Array<unknown>
            ) => unknown;
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
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
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
): Fetcher {
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
  });
}
