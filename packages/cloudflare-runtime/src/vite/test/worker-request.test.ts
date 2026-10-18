import { once } from "node:events";
import * as NodeHttp from "node:http";
import { URL } from "node:url";
import { createLogger } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardWorkerRequest } from "../worker-request.ts";

describe("forwardWorkerRequest", () => {
  const servers: NodeHttp.Server[] = [];
  const clients: NodeHttp.ClientRequest[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await Promise.all(servers.splice(0).map(closeServer));
    vi.restoreAllMocks();
  });

  async function listen(handler: NodeHttp.RequestListener) {
    const server = NodeHttp.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal: AbortSignal.timeout(2_000) });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP address");
    }
    return { server, url: new URL(`http://127.0.0.1:${address.port}/`) };
  }

  async function proxy(target: URL) {
    const logger = createLogger("silent");
    const error = vi.spyOn(logger, "error");
    const { url } = await listen((request, response) => {
      forwardWorkerRequest(request, response, target, "test-secret", logger);
    });
    return { url, error };
  }

  function request(url: URL, listener: (response: NodeHttp.IncomingMessage) => void) {
    const client = NodeHttp.request(url, { method: "POST", agent: false }, listener);
    clients.push(client);
    client.setTimeout(2_000, () => client.destroy(new Error("Client request timed out")));
    return client;
  }

  function read(url: URL, body = "") {
    return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const client = request(url, (response) => {
        let result = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (result += chunk));
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode, body: result }));
      });
      client.on("error", reject);
      client.end(body);
    });
  }

  it("preserves the request body and Worker response status and body", async () => {
    const worker = await listen((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        response.writeHead(201, { "content-type": "text/plain" });
        response.end(`received: ${body}`);
      });
    });
    const gateway = await proxy(worker.url);

    await expect(read(gateway.url, "hello Worker")).resolves.toEqual({
      status: 201,
      body: "received: hello Worker",
    });
    expect(gateway.error).not.toHaveBeenCalled();
  });

  it("returns 502 when the Worker is unavailable without an unhandled request error", async () => {
    const worker = await listen((_request, response) => response.end());
    await closeServer(worker.server);
    const gateway = await proxy(worker.url);

    await expect(read(gateway.url)).resolves.toEqual({ status: 502, body: "Bad Gateway" });
    expect(gateway.error).toHaveBeenCalledOnce();
  });

  it("closes a partial response without appending a 502 body", async () => {
    let workerResponse: NodeHttp.ServerResponse | undefined;
    const worker = await listen((_request, response) => {
      workerResponse = response;
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    });
    const gateway = await proxy(worker.url);

    const result = await new Promise<{
      status: number | undefined;
      body: string;
      complete: boolean;
    }>((resolve, reject) => {
      const client = request(gateway.url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          // Cut the Worker off only once the client has received its first bytes.
          workerResponse?.destroy();
        });
        response.on("error", () => {});
        response.on("close", () => {
          resolve({ status: response.statusCode, body, complete: response.complete });
        });
      });
      client.on("error", reject);
      client.end();
    });

    expect(result).toEqual({ status: 200, body: "partial", complete: false });
    expect(gateway.error).toHaveBeenCalledOnce();
  });

  it("cancels the Worker request when the client abandons a streaming response", async () => {
    let workerResponse: NodeHttp.ServerResponse | undefined;
    const worker = await listen((_request, response) => {
      workerResponse = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: connected\n\n");
    });
    const gateway = await proxy(worker.url);

    await new Promise<void>((resolve, reject) => {
      const client = request(gateway.url, (response) => {
        response.on("error", () => {});
        response.once("data", () => {
          if (!workerResponse) {
            reject(new Error("Worker response was not opened"));
            return;
          }
          const closed = once(workerResponse, "close", { signal: AbortSignal.timeout(2_000) });
          client.destroy();
          closed.then(() => resolve(), reject);
        });
      });
      client.on("error", reject);
      client.end();
    });

    expect(workerResponse?.destroyed).toBe(true);
    expect(workerResponse?.writableEnded).toBe(false);
    expect(gateway.error).not.toHaveBeenCalled();
  });
});

async function closeServer(server: NodeHttp.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
