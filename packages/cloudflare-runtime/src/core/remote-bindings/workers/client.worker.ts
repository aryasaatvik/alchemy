import { newWebSocketRpcSession } from "capnweb";
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  type ArtifactsRepositoryMetadataResult,
  type ArtifactsRepositoryOperations,
  type ArtifactsRepositoryWireOperations,
} from "../../bindings/ArtifactsRpc.ts";

interface Props {
  binding: string;
  bindingType: string;
  namespace?: string;
}

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
      ctx.props.namespace,
    );

    return new Proxy(this, {
      get: (target, prop) => {
        if (
          ctx.props.bindingType === "artifacts" &&
          (prop === "artifactsGetMetadata" || prop === "artifactsGetMethods")
        ) {
          return async (name: string) => {
            if (prop === "artifactsGetMetadata") {
              const result = await (
                Reflect.get(stub, "getMetadata") as (
                  name: string,
                ) => Promise<ArtifactsRepositoryMetadataResult>
              )(name);
              return result;
            }
            const methods = await (
              Reflect.get(stub, "getMethods") as (
                name: string,
              ) => Promise<ArtifactsRepositoryWireOperations>
            )(name);
            return new ArtifactsRepositoryMethodsBridge(methods);
          };
        }
        if (
          ctx.props.bindingType === "artifacts" &&
          (prop === "create" || prop === "import" || prop === "list" || prop === "delete")
        ) {
          return async (...args: unknown[]) => {
            const operation = Reflect.get(stub, prop) as (...args: unknown[]) => Promise<unknown>;
            const result = await operation(...args);
            return prop === "delete" ? result : JSON.parse(result as string);
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
  artifactsNamespace?: string,
): Fetcher {
  const url = new URL("ws://stub");
  url.searchParams.set("MF-Binding", bindingName);
  if (bindingType) {
    url.searchParams.set("MF-Binding-Type", bindingType);
  }
  if (artifactsNamespace) {
    url.searchParams.set("MF-Artifacts-Namespace", artifactsNamespace);
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
