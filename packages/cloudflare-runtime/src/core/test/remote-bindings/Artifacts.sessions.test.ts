import * as http from "node:http";
import type { Socket } from "node:net";
import { expect, layer } from "@effect/vitest";
import { RpcSession, WebSocketTransport } from "capnweb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WebSocketServer, type WebSocket } from "ws";
import { ArtifactsBindingProxy } from "../../bindings/artifacts/ArtifactsRpc.ts";
import { Artifacts as ArtifactsBinding } from "../../bindings/index.ts";
import * as RemoteBindings from "../../remote-bindings/RemoteBindings.ts";
import * as RemoteWorker from "../../remote-bindings/RemoteWorker.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

/**
 * Cap'n Web session lifetime for remote Artifacts bindings, against a fake
 * preview worker that serves `ArtifactsBindingProxy` over WebSockets.
 *
 * Every session holds a WebSocket to the preview worker until it is closed,
 * so an operation that leaves its session open leaks a connection per call
 * against the edge, and a repository handle tied to one session fails once
 * that WebSocket drops.
 */

const edge = {
  url: "",
  sockets: new Set<WebSocket>(),
  upgrades: 0,
  nativeDisposals: 0,
};

let gateNextMethodsReply = false;
let pipelineDispatched = false;
let releaseMethodsReply: (() => void) | undefined;

/** Withhold the capability response until its pipelined native method actually runs. */
class GatedWebSocketTransport extends WebSocketTransport {
  #pending: string[] | undefined;

  holdMethodsReply() {
    this.#pending = [];
    releaseMethodsReply = () => {
      const pending = this.#pending ?? [];
      this.#pending = undefined;
      releaseMethodsReply = undefined;
      for (const message of pending) super.send(message);
    };
  }

  override send(message: string) {
    if (this.#pending !== undefined) this.#pending.push(message);
    else super.send(message);
  }
}

const repositoryInfo = {
  id: "starter-id",
  name: "starter",
  description: null,
  defaultBranch: "main",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastPushAt: null,
  source: null,
  readOnly: false,
};

const artifacts: Artifacts = {
  create: async () => {
    throw new Error("not used");
  },
  import: async () => {
    throw new Error("not used");
  },
  delete: async () => false,
  list: async () => ({ repos: [repositoryInfo], total: 1 }),
  get: async () => ({
    [Symbol.dispose]: () => {
      edge.nativeDisposals++;
    },
    info: async () => {
      if (releaseMethodsReply !== undefined) {
        pipelineDispatched = true;
        releaseMethodsReply();
      }
      return { ...repositoryInfo, remote: "https://example.com/starter.git" };
    },
    readBlob: async () => new Blob([new Uint8Array([0, 255, 195, 169])]),
    readFile: async (args) => {
      if (args.path === "invalid")
        throw Object.assign(new Error("Invalid file path"), {
          name: "ArtifactsError",
          code: "INVALID_INPUT",
          numericCode: 10002,
        });
      return new Blob([new Uint8Array([0, 255, 195, 169])], { type: "application/octet-stream" });
    },
    readTree: async () => [],
    readCommit: async () => null,
    log: async () => [],
    createToken: async (scope?: "write" | "read") => ({
      id: "token-id",
      plaintext: "secret",
      scope: scope ?? "write",
      expiresAt: "2026-09-01T01:00:00.000Z",
    }),
    listTokens: async () => ({ tokens: [], total: 0 }),
    revokeToken: async () => true,
    fork: async () => {
      throw new Error("not used");
    },
  }),
};

const StubRemoteWorker = Layer.succeed(
  RemoteWorker.RemoteWorker,
  RemoteWorker.RemoteWorker.of({
    deploy: () => Effect.sync(() => ({ url: edge.url, headers: {} })),
  }),
);

/** Drop every open session the way a lost connection does (close code 1006). */
const dropSessions = () => {
  for (const socket of edge.sockets) {
    (socket as unknown as { _socket: Socket })._socket.destroy();
  }
};

const startFakeEdge = Effect.acquireRelease(
  Effect.callback<http.Server>((resume) => {
    const sessions = new WebSocketServer({ noServer: true });
    const server = http.createServer((request, response) => {
      if (request.url === "/drop") dropSessions();
      response.end();
    });
    server.on("upgrade", (request, socket, head) => {
      edge.upgrades++;
      sessions.handleUpgrade(request, socket, head, (webSocket) => {
        edge.sockets.add(webSocket);
        webSocket.on("close", () => edge.sockets.delete(webSocket));
        const transport = new GatedWebSocketTransport(webSocket as never);
        class GatedArtifactsProxy extends ArtifactsBindingProxy {
          override async getMethods(name: string) {
            if (gateNextMethodsReply) {
              gateNextMethodsReply = false;
              transport.holdMethodsReply();
            }
            return super.getMethods(name);
          }
        }
        new RpcSession(transport, new GatedArtifactsProxy(artifacts)).getRemoteMain();
      });
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.tap((server) =>
    Effect.sync(() => {
      edge.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      edge.sockets.clear();
      edge.upgrades = 0;
      edge.nativeDisposals = 0;
      gateNextMethodsReply = false;
      pipelineDispatched = false;
      releaseMethodsReply = undefined;
    }),
  ),
);

const WORKER_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const repository = await env.ARTIFACTS.get("starter");
      try {
        if (url.pathname === "/error") {
          try { await repository.readFile({ref: "main", path: "invalid"}); }
          catch (error) { return new Response(error.code); }
          throw new Error("Expected an Artifacts read error");
        }
        const info = await repository.info();
        if (info.remote !== "https://example.com/starter.git") throw new Error("Invalid metadata");
        const file = await repository.readFile({ref: "main", path: "fixture.bin"});
        if (file.type !== "application/octet-stream" || String(new Uint8Array(await file.arrayBuffer())) !== "0,255,195,169") throw new Error("Invalid blob transport");
        const token = await repository.createToken("read", 60);
        if (url.searchParams.has("drop")) await fetch(url.searchParams.get("drop"));
        return new Response(String(await repository.revokeToken(token.id)));
      } finally {
        repository[Symbol.dispose]();
      }
    } catch (error) {
      return new Response(String(error?.stack ?? error), { status: 500 });
    }
  }
};
`;

const testLayer = RemoteBindings.RemoteBindingsLive.pipe(
  Layer.provide(StubRemoteWorker),
  Layer.provideMerge(localRuntimeLayer),
);

const startWorker = (name: string) =>
  startTestWorker({
    name,
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    bindings: [ArtifactsBinding.remote("ARTIFACTS", "ns")],
    modules: [{ name: "main.js", type: "ESModule", content: WORKER_SCRIPT }],
  });

const settledOpenSessions = Effect.promise(async () => {
  const deadline = Date.now() + 5_000;
  while (edge.sockets.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return edge.sockets.size;
});

layer(testLayer, { excludeTestServices: true })("Artifacts remote binding sessions", (it) => {
  it.effect(
    "dispatches a repository method before its getMethods reply is delivered",
    () =>
      Effect.gen(function* () {
        yield* startFakeEdge;
        const worker = yield* startWorker("artifacts-methods-pipeline");
        gateNextMethodsReply = true;

        const reply = yield* worker
          .fetchText("/")
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.ensuring(Effect.sync(() => releaseMethodsReply?.())),
          );

        expect(reply).toBe("true");
        expect(pipelineDispatched).toBe(true);
        expect(edge.nativeDisposals).toBe(5);
        expect(yield* settledOpenSessions).toBe(0);
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  it.effect(
    "closes each operation's session",
    () =>
      Effect.gen(function* () {
        yield* startFakeEdge;
        const worker = yield* startWorker("artifacts-sessions-closed");

        for (let call = 0; call < 20; call++) {
          expect(yield* worker.fetchText("/")).toBe("true");
        }

        expect(edge.upgrades).toBeGreaterThan(0);
        expect(edge.nativeDisposals).toBe(100);
        expect(yield* worker.fetchText("/error")).toBe("INVALID_INPUT");
        expect(edge.nativeDisposals).toBe(102);
        expect(yield* settledOpenSessions).toBe(0);
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  it.effect(
    "keeps a repository usable after its sessions drop",
    () =>
      Effect.gen(function* () {
        yield* startFakeEdge;
        const worker = yield* startWorker("artifacts-sessions-dropped");

        const response = yield* worker.fetch(`/?drop=${encodeURIComponent(`${edge.url}/drop`)}`);

        expect(yield* Effect.promise(() => response.text())).toBe("true");
        expect(response.status).toBe(200);
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );
});
