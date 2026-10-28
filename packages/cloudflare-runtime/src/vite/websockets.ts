import type { IncomingMessage } from "node:http";
import * as NodeNet from "node:net";
import type { Duplex } from "node:stream";
import type * as vite from "vite";
import { proxyRequestHeaders, resolveForwardedHost } from "./forwarded-host.ts";
import { workerRequestUrl } from "./worker-request.ts";

const claimedUpgrades = new WeakSet<Duplex>();

/**
 * Reserve a matching upgrade before asynchronous verification that does not return a promise
 * from its event listener (for example, `ws`'s callback-based `verifyClient`). Call only after
 * matching the plugin's route. An async listener can instead return its full completion promise.
 */
export const claimWebSocketUpgrade = (socket: Duplex): void => {
  claimedUpgrades.add(socket);
};

/**
 * Handles 'upgrade' requests on the Vite HTTP server and forwards the
 * WebSocket handshake to the local workerd address as a raw HTTP upgrade.
 *
 * Returns a cleanup function that removes the listener (used on server restart).
 */
export function handleWebSocket(
  httpServer: vite.HttpServer,
  address: string | URL,
  proxySharedSecret: string,
): () => void {
  const upstreamBase = typeof address === "string" ? new URL(address) : address;

  // Sockets hijacked by an `upgrade` are not reaped by `server.closeAllConnections()`,
  // yet `server.close()` still waits on them — so a lingering proxied WebSocket blocks
  // the HTTP server from closing on restart. Track live sockets and destroy them in the
  // cleanup function to close deterministically.
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  // An `async` listener (Vite's `server.proxy` awaiting its `bypass`, a
  // plugin authenticating first) may take an upgrade only after the Worker
  // has answered it, without touching the socket before. `emit` is wrapped to
  // keep the promises the other listeners return for each socket, and the
  // Worker's answer waits for them to settle.
  const pending = new WeakMap<Duplex, Promise<unknown>>();
  const emit = httpServer.emit;
  const emitUpgrade = function (
    this: vite.HttpServer,
    event: string | symbol,
    ...args: Array<any>
  ) {
    if (event !== "upgrade") return emit.call(this, event, ...args);
    const settling: Array<PromiseLike<unknown>> = [];
    for (const listener of this.rawListeners("upgrade")) {
      const result: unknown = listener.apply(this, args);
      if (isPromiseLike(result)) settling.push(result);
    }
    if (settling.length > 0) pending.set(args[1] as Duplex, Promise.allSettled(settling));
    return true;
  } as typeof emit;
  httpServer.emit = emitUpgrade;

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Unhandled socket errors crash Node.
    socket.on("error", () => socket.destroy());

    // The URL — and thus the Sandbox-origin check below — is built from the
    // resolved (forwarded) host, not the raw `Host` header. This diverges from
    // upstream, which keys the origin off `Host`; here it's intentional so a
    // tunnel-fronted Sandbox preview still matches. Direct Sandbox hits carry no
    // `X-Forwarded-Host`, so they fall back to `Host` and behave identically.
    const rawHost = resolveForwardedHost(request.headers, "localhost");
    const base = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
    const url = workerRequestUrl(request.url, base);

    const isViteRequest = request.headers["sec-websocket-protocol"]?.startsWith("vite") ?? false;
    const isSandboxRequest = hasSandboxOrigin(url.origin);

    // Vite handles its own HMR upgrades; forward Sandbox preview URLs anyway.
    if (isViteRequest && !isSandboxRequest) {
      return;
    }

    const target = new URL(url.pathname + url.search, upstreamBase);
    // A raw TCP tunnel rather than a `node:http` client request: Bun's
    // `node:http` client never emits `upgrade`, so the handshake would hang
    // there. Writing the request head and piping both ways relays the
    // Worker's answer byte for byte, whether a 101 or a refusal (a 403, a
    // 404, ...) that must reach the client rather than a connection reset.
    const upstream = NodeNet.connect({ host: target.hostname, port: Number(target.port) });
    track(socket);
    track(upstream);
    socket.on("close", () => upstream.destroy());

    // Other plugins serve their own WebSockets on the dev server (a DevTools
    // relay, `server.proxy` with `ws: true`), and every `upgrade` listener sees
    // every upgrade. This listener runs first (see `prependListener` below),
    // so it records the socket's state before any other listener can touch
    // it. A socket another listener has since written to, ended, or explicitly
    // claimed belongs to that listener: the Worker's answer is
    // dropped rather than written over the other listener's handshake.
    const before = socketWrittenBytes(socket);
    const claimed = () => isClaimed(socket, before);

    // The Worker's answer is buffered until it is known who answers the
    // client: an asynchronous listener may claim the socket while the request
    // is in flight, or may still be deciding when the Worker answers.
    const answer: Array<Buffer> = [];
    const buffer = (chunk: Buffer) => answer.push(chunk);
    let relaying = false;
    const relay = () => {
      upstream.off("data", buffer);
      if (claimed()) {
        // Leaves the socket to the listener that claimed it.
        sockets.delete(socket);
        upstream.destroy();
        return;
      }
      if (upstream.destroyed) {
        // The Worker closed: relay its whole (buffered) answer, or reset the
        // client if it never answered.
        if (answer.length === 0) {
          socket.destroy();
          return;
        }
        for (const chunk of answer) socket.write(chunk);
        socket.end();
        return;
      }
      relaying = true;
      for (const chunk of answer) socket.write(chunk);
      // oxlint-disable-next-line effecttsgo/unnecessary-pipe-chain -- Node stream piping (socket -> upstream -> socket), not Effect pipe
      socket.pipe(upstream).pipe(socket);
    };
    let decided = false;
    const decide = () => {
      if (decided) return;
      decided = true;
      const settled = pending.get(socket);
      if (settled === undefined) return relay();
      void settled.then(relay);
    };
    upstream.on("data", buffer);
    upstream.once("data", decide);
    upstream.on("error", () => upstream.destroy());
    upstream.on("close", () => {
      if (relaying) socket.destroy();
      else decide();
    });
    upstream.once("connect", () => {
      if (socket.destroyed || claimed()) {
        sockets.delete(socket);
        upstream.destroy();
        return;
      }
      const lines = [`${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`];
      for (const [name, value] of Object.entries(
        proxyRequestHeaders(request, url, proxySharedSecret),
      )) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${item}`);
        }
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) {
        upstream.write(head);
      }
    });
  };

  httpServer.prependListener("upgrade", onUpgrade);
  return () => {
    if (httpServer.emit === emitUpgrade) httpServer.emit = emit;
    httpServer.off("upgrade", onUpgrade);
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  };
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

// `bytesWritten` counts what Node has queued; Bun counts only what it has
// flushed, so the queued `writableLength` is added for both.
const socketWrittenBytes = (socket: Duplex): number =>
  ((socket as Partial<NodeNet.Socket>).bytesWritten ?? 0) + socket.writableLength;

// Vite attaches an error listener even when it declines a non-HMR upgrade. Only a response,
// closure, or an explicit claim transfers ownership; subscriptions alone prove nothing.
const isClaimed = (socket: Duplex, before: number) =>
  socket.destroyed ||
  socket.writableEnded ||
  socketWrittenBytes(socket) > before ||
  claimedUpgrades.has(socket);

/**
 * Matches the origin of a Sandbox SDK preview URL.
 * See: https://developers.cloudflare.com/sandbox/concepts/preview-urls/
 *
 * Pattern: https?://<port(4+ digits)>-<id(no dots)>-<token>.localhost
 *
 * IMPORTANT: The token segment is [a-z0-9_]+ (no hyphens) to prevent ReDoS — two adjacent
 * [^.]+ groups separated by - cause quadratic backtracking on hyphen-heavy input. Tokens
 * are documented as letters/digits/underscores only.
 */
export const SANDBOX_ORIGIN_REGEXP = /^https?:\/\/\d{4,}-[^.]+-[a-z0-9_]+\.localhost(:\d+)?$/i;

function hasSandboxOrigin(origin: string) {
  return SANDBOX_ORIGIN_REGEXP.test(origin);
}
