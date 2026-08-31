import { newWebSocketRpcSession } from "capnweb";
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  type ArtifactsRepositoryOperations,
  type ArtifactsRepositoryMetadata,
} from "../../bindings/ArtifactsRpc.ts";

interface Props {
  binding: string;
  bindingType: string;
}

class ArtifactsRepositoryMethodsBridge extends RpcTarget {
  readonly #methods: ArtifactsRepositoryOperations;

  constructor(methods: ArtifactsRepositoryOperations) {
    super();
    this.#methods = methods;
  }

  createToken(scope?: "write" | "read", ttl?: number) {
    return this.#methods.createToken(scope, ttl);
  }

  listTokens() {
    return this.#methods.listTokens();
  }

  revokeToken(tokenOrId: string) {
    return this.#methods.revokeToken(tokenOrId);
  }

  fork(name: string, options?: Parameters<ArtifactsRepo["fork"]>[1]) {
    return this.#methods.fork(name, options);
  }
}

/** Generic remote proxy client for bindings. */
export default class Client extends WorkerEntrypoint<unknown, Props> {
  fetch(request: Request): Promise<Response> {
    return makeFetch(this.ctx.props.binding)(request);
  }

  constructor(ctx: ExecutionContext<Props>, env: unknown) {
    super(ctx, env);
    const stub = makeRemoteProxyStub(
      ctx.props.binding,
      undefined,
      ctx.props.bindingType,
    );

    return new Proxy(this, {
      get: (target, prop) => {
        if (
          ctx.props.bindingType === "artifacts" &&
          (prop === "artifactsGetMetadata" || prop === "artifactsGetMethods")
        ) {
          return async (name: string) => {
            if (prop === "artifactsGetMetadata") {
              return (
                Reflect.get(stub, "getMetadata") as (
                  name: string,
                ) => Promise<ArtifactsRepositoryMetadata>
              )(name);
            }
            const methods = await (
              Reflect.get(stub, "getMethods") as (
                name: string,
              ) => Promise<ArtifactsRepositoryOperations>
            )(name);
            return new ArtifactsRepositoryMethodsBridge(methods);
          };
        }
        if (Reflect.has(target, prop)) {
          return Reflect.get(target, prop);
        }
        return Reflect.get(stub, prop);
      },
    });
  }
}

/** Headers sent alongside proxy requests to provide additional context. */
export type ProxyMetadata = {
  "MF-Dispatch-Namespace-Options"?: string;
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
  bindingType?: string,
): Fetcher {
  const url = new URL("ws://stub");
  url.searchParams.set("MF-Binding", bindingName);
  if (bindingType) {
    url.searchParams.set("MF-Binding-Type", bindingType);
  }
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
