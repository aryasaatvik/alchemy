import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import * as vite from "vite";
import { expect, onTestFinished, test, vi } from "vitest";
import * as Assets from "../../core/bindings/assets/Assets.ts";
import cloudflareVitePlugin from "../plugin.ts";

test.each([
  ["selective Worker routes", ["/api/*"]],
  ["explicitly excluded internal routes", ["/api/*", "!/cdn-cgi/alchemy/module-runner/*"]],
  ["assets first", false],
  ["Worker first", true],
] as const)("starts the module runner with SPA fallback and %s", async (_, runWorkerFirst) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  // These tests use only the local runtime; no Cloudflare API calls are needed.
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "worker.js");
  await fs.writeFile(path.join(root, "index.html"), "<html><body>SPA shell</body></html>");
  await fs.writeFile(
    entry,
    `
    export default {
      fetch(request, env) {
        if (new URL(request.url).pathname.startsWith("/api/")) {
          return new Response("api");
        }
        return env.ASSETS.fetch(request);
      },
    };
  `,
  );
  const server = await vite.createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      cloudflareVitePlugin({
        main: entry,
        worker: {
          name: "vite-dev-assets-test",
          bindings: [Assets.local("ASSETS")],
          assets: {
            runWorkerFirst:
              typeof runWorkerFirst === "boolean" ? runWorkerFirst : [...runWorkerFirst],
            notFoundHandling: "single-page-application",
          },
        },
      }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  const url = server.resolvedUrls!.local[0];
  const page = await fetch(new URL("/dashboard", url), {
    signal: AbortSignal.timeout(5_000),
  });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("SPA shell");
  if (runWorkerFirst !== false) {
    const api = await fetch(new URL("/api/hello", url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(api.status).toBe(200);
    expect(await api.text()).toBe("api");
  }
});

test.each(["same-origin", "synthetic"] as const)(
  "a Worker reads public assets through ASSETS with %s authority",
  async (authority) => {
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
    const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
    await fs.mkdir(tmpRoot, { recursive: true });
    const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-public-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await fs.mkdir(path.join(root, "public"));
    await fs.writeFile(
      path.join(root, "public", "about.html"),
      "<html><body>public page</body></html>",
    );
    await fs.writeFile(path.join(root, "public", "og.png"), png);
    await fs.writeFile(path.join(root, "index.html"), "<html><body>root page</body></html>");
    await fs.writeFile(path.join(root, "module.ts"), 'export const value: string = "transformed";');
    const denied = `${root}-outside.txt`;
    await fs.writeFile(denied, "outside the Vite filesystem allow list");
    onTestFinished(() => fs.rm(denied));
    const project = '{"files":{"welcome.tsx":"export default 1"}}\n';
    await fs.mkdir(path.join(root, "public", "starters", "projects"), { recursive: true });
    await fs.writeFile(path.join(root, "public", "starters", "projects", "welcome.json"), project);
    const entry = path.join(root, "worker.js");
    await fs.writeFile(
      entry,
      `
    export default {
      fetch(request, env) {
        const { pathname, search } = new URL(request.url);
        const origin = ${JSON.stringify(authority)} === "synthetic"
          ? "https://assets.invalid"
          : request.url;
        const assetUrl = new URL(pathname.slice("/read".length) + search, origin).href;
        return env.ASSETS.fetch(request.method === "GET" ? assetUrl : new Request(assetUrl, request));
      },
    };
  `,
    );
    const server = await vite.createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
        allowedHosts: ["host.docker.internal"],
        fs: { strict: true, allow: [root] },
      },
      plugins: [
        {
          name: "asset-request-contract",
          configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
              if (!request.url?.startsWith("/bridge-contract?")) return next();
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk));
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  url: request.url,
                  method: request.method,
                  header: request.headers["x-asset-test"],
                  body: Buffer.concat(chunks).toString(),
                }),
              );
            });
          },
        },
        cloudflareVitePlugin({
          main: entry,
          worker: {
            name: "vite-dev-assets-public-test",
            bindings: [Assets.local("ASSETS")],
            assets: { runWorkerFirst: ["/read/*"] },
          },
        }),
      ],
    });
    onTestFinished(() => server.close());
    await server.listen();
    const url = server.resolvedUrls!.local[0];

    expect(server.config.server.allowedHosts).not.toBe(true);
    expect(server.config.server.allowedHosts).not.toContain("assets.invalid");
    // fetch controls Host itself; use node:http to exercise Vite's external Host policy.
    const blocked = await new Promise<{
      status: number | undefined;
      type: string | undefined;
      body: string;
    }>((resolve, reject) => {
      const request = http.get(
        new URL("/starters/projects/welcome.json", url).href,
        {
          headers: { host: "external.invalid" },
          signal: AbortSignal.timeout(5_000),
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({ status: response.statusCode, type: response.headers["content-type"], body }),
          );
        },
      );
      request.on("error", reject);
    });
    expect(blocked).toEqual({
      status: 403,
      type: "text/plain",
      body: 'Blocked request. This host ("external.invalid") is not allowed.\nTo allow this host, add "external.invalid" to `server.allowedHosts` in vite.config.js.',
    });
    const json = await fetch(new URL("/read/starters/projects/welcome.json", url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect({
      status: json.status,
      type: json.headers.get("content-type"),
      body: await json.text(),
    }).toEqual({
      status: 200,
      type: "application/json",
      body: project,
    });

    const head = await fetch(new URL("/read/starters/projects/welcome.json", url), {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/json");
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(project)));
    expect(await head.text()).toBe("");

    const contract = await fetch(new URL("/read/bridge-contract?x=%2F&x=two", url), {
      method: "POST",
      headers: { "x-asset-test": "retained" },
      body: "asset request body",
      signal: AbortSignal.timeout(5_000),
    });
    expect(contract.status).toBe(200);
    expect(await contract.json()).toEqual({
      url: "/bridge-contract?x=%2F&x=two",
      method: "POST",
      header: "retained",
      body: "asset request body",
    });

    const module = await fetch(new URL("/read/module.ts", url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(module.status).toBe(200);
    expect(module.headers.get("content-type")).toContain("javascript");
    expect(await module.text()).toContain('export const value = "transformed"');
    const raw = await fetch(new URL("/read/module.ts?raw", url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain("value: string");

    const forbidden = await fetch(new URL(`/read/@fs/${denied}`, url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).not.toContain("outside the Vite filesystem allow list");

    const html = await fetch(new URL("/read/index.html", url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("/@vite/client");

    const page = await fetch(new URL("/read/about", url), { signal: AbortSignal.timeout(5_000) });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe("<html><body>public page</body></html>");

    const image = await fetch(new URL("/read/og.png", url), { signal: AbortSignal.timeout(5_000) });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
  },
);
