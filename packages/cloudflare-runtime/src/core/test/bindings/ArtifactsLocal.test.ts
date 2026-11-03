import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Artifacts from "../../bindings/artifacts/Artifacts.ts";
import { GitClient, gitEnvironment } from "../../bindings/artifacts/git-client.ts";
import { startGitSidecar } from "../../bindings/artifacts/git-sidecar.ts";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import { localRuntimeLayer, makeTempDirectory, startTestWorker } from "../helpers/runtime.ts";

const artifactsRuntimeLayer = (storage: ReturnType<typeof Storage.layerDisk>) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(RuntimeServices.layerLocalBindings()),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(RuntimeServices.layerLoopback()),
    Layer.provideMerge(storage),
    Layer.provide(Internet.InternetLive),
    Layer.provideMerge(RuntimeServices.layerRegistry()),
    Layer.provide(Paths.PathsLive),
    Layer.provide(Docker.DockerLive),
    Layer.provide(Workerd.WorkerdLive),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );

const exec = promisify(execFile);
const script = `export default { async fetch(request, env) {
  const {op, name = "project", token} = await request.json();
  try {
    let result;
    if (op === "create") result = await env.REPOS.create(name);
    else if (op === "list") result = await env.REPOS.list();
    else if (op === "get") result = await (await env.REPOS.get(name)).info();
    else if (op === "token") result = await (await env.REPOS.get(name)).createToken("write");
    else if (op === "revoke") result = await (await env.REPOS.get(name)).revokeToken(token);
    else if (op === "delete") result = await env.REPOS.delete(name);
    return Response.json(result);
  } catch (error) { return Response.json({code: error.code, message: error.message}, {status: 400}); }
} };`;

describe("local Artifacts", () => {
  it.effect(
    "serves RPC metadata, tokens, shallow fetch and fast-forward Git push",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "artifacts-local",
          compatibilityDate: "2026-09-03",
          compatibilityFlags: [],
          modules: [{ name: "main.js", type: "ESModule", content: script }],
          bindings: [Artifacts.local({ binding: "REPOS", namespace: "templates" })],
        });
        const command = <T>(op: string, extra = {}) =>
          worker.fetchJson<T>("/", {
            method: "POST",
            body: JSON.stringify({ op, ...extra }),
          });
        expect(yield* command("get")).toMatchObject({ code: "NOT_FOUND" });
        const created = yield* command<{ remote: string; token: string }>("create");
        expect(created.remote).toMatch(/^http:\/\/127.0.0.1:\d+\/git\/templates\/project.git$/);
        expect(yield* command("create")).toMatchObject({ code: "ALREADY_EXISTS" });
        expect(yield* command("get")).toMatchObject({ remote: created.remote });
        expect(yield* command("list")).toMatchObject({ total: 1 });
        const token = yield* command<{ id: string; plaintext: string }>("token");
        const directory = yield* makeTempDirectory();
        yield* Effect.promise(async () => {
          const git = (...args: string[]) =>
            exec("git", args, { cwd: directory, env: gitEnvironment() });
          await git("init", "--initial-branch=main");
          await writeFile(`${directory}/template.txt`, "first");
          await git("add", ".");
          await git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "first",
          );
          const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${token.plaintext}`).toString("base64")}`;
          await git("-c", `http.extraHeader=${auth}`, "push", created.remote, "main");
          await writeFile(`${directory}/template.txt`, "second");
          await git("add", ".");
          await git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "second",
          );
          await git("-c", `http.extraHeader=${auth}`, "push", created.remote, "main");
          await git(
            "-c",
            `http.extraHeader=${auth}`,
            "clone",
            "--depth=1",
            created.remote,
            "shallow",
          );
          const shallow = await git("-C", "shallow", "rev-parse", "--is-shallow-repository");
          expect(shallow.stdout.trim()).toBe("true");
          expect((await fetch(`${created.remote}/info/refs?service=git-upload-pack`)).status).toBe(
            401,
          );
        });
        expect(yield* command("revoke", { token: token.id })).toBe(true);
        const response = yield* Effect.promise(() =>
          fetch(`${created.remote}/info/refs?service=git-upload-pack`, {
            headers: {
              Authorization: `Basic ${Buffer.from(`x-access-token:${token.plaintext}`).toString("base64")}`,
            },
          }),
        );
        expect(response.status).toBe(401);
        expect(yield* command("delete")).toBe(true);
        expect(yield* command("list")).toMatchObject({ total: 0 });
      }).pipe(Effect.scoped, Effect.provide(localRuntimeLayer)),
    { timeout: 60000 },
  );
});

// Windows may briefly retain workerd file locks; storage cleanup retries use real time.
it.live(
  "closes listeners and removes temporary repository state with the runtime scope",
  () =>
    Effect.gen(function* () {
      let remote = "";
      let userUrl: URL | undefined;
      let runtimeReleased = false;
      let firstRemoval: unknown;
      const removalFailures: unknown[] = [];
      const listenerState = (url: URL | undefined) =>
        new Promise<boolean | "unknown" | "timeout">((resolve) => {
          if (!url) return resolve("unknown");
          const socket = createConnection({ host: url.hostname, port: Number(url.port) });
          const done = (state: boolean | "timeout") => {
            socket.destroy();
            resolve(state);
          };
          socket.once("connect", () => done(true));
          socket.once("error", () => done(false));
          socket.setTimeout(1000, () => done("timeout"));
        });
      const observedFs = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) =>
          FileSystem.FileSystem.of({
            ...fs,
            remove: (directory, options) =>
              Effect.gen(function* () {
                if (firstRemoval === undefined) {
                  const [files, userListener, gitListener] = yield* Effect.promise(() =>
                    Promise.all([
                      readdir(directory, { recursive: true }).catch((error: unknown) => [
                        String(error),
                      ]),
                      listenerState(userUrl),
                      listenerState(remote ? new URL(remote) : undefined),
                    ]),
                  );
                  firstRemoval = { runtimeReleased, userListener, gitListener, files };
                }
                return yield* fs.remove(directory, options).pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      removalFailures.push({
                        runtimeReleased,
                        reason: error.reason,
                        message: error.message,
                      });
                    }),
                  ),
                );
              }),
          }),
        ),
      );
      const storageLayer = Storage.layerTemp().pipe(Layer.provide(observedFs));
      const runtimeLayer = artifactsRuntimeLayer(storageLayer);
      const root = yield* Effect.gen(function* () {
        const storage = yield* Storage.Storage;
        if (!("disk" in storage) || !storage.disk) throw new Error("Expected disk storage");
        // Registered before start: this runs after the runtime's child scopes close.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeReleased = true;
          }),
        );
        const worker = yield* startTestWorker({
          name: "artifacts-cleanup",
          compatibilityDate: "2026-09-03",
          compatibilityFlags: [],
          modules: [{ name: "main.js", type: "ESModule", content: script }],
          bindings: [Artifacts.local({ binding: "REPOS", namespace: "cleanup" })],
        });
        userUrl = worker.baseUrl;
        const created = yield* worker.fetchJson<{ remote: string; token: string }>("/", {
          method: "POST",
          body: JSON.stringify({ op: "create" }),
        });
        remote = created.remote;
        expect(
          yield* HttpClient.get(`${remote}/info/refs?service=git-upload-pack`, {
            headers: {
              Authorization: `Basic ${Buffer.from(`x-access-token:${created.token}`).toString("base64")}`,
            },
          }).pipe(
            Effect.flatMap((response) => Effect.as(response.text, response.status)),
            Effect.provide(NodeHttpClient.layerNodeHttp),
          ),
        ).toBe(200);
        expect(
          yield* Effect.promise(() =>
            readdir(`${storage.disk.path}/artifacts`, { recursive: true }),
          ),
        ).toContainEqual(expect.stringMatching(/\.git[\\/]HEAD$/));
        return storage.disk.path;
      }).pipe(
        // Close Runtime.start's child scopes before releasing the storage layer.
        Effect.scoped,
        Effect.provide(runtimeLayer),
      );
      const cleanupDetails = JSON.stringify({ firstRemoval, removalFailures });
      expect(firstRemoval, cleanupDetails).toMatchObject({
        runtimeReleased: true,
      });
      expect(
        yield* Effect.promise(() =>
          stat(root).then(
            () => true,
            (error) => {
              if (error.code !== "ENOENT") throw error;
              return false;
            },
          ),
        ),
        cleanupDetails,
      ).toBe(false);
      expect(
        // Like Workerd.test, avoid Undici's macOS setTypeOfService exception
        // outside the fetch promise when connecting during shutdown. This
        // probe owns its HTTP agent and consumes any unexpected response.
        yield* HttpClient.get(`${remote}/info/refs?service=git-upload-pack`).pipe(
          // Receiving any response proves the listener is still open, even if
          // its body fails while draining. Only connection/request failure is false.
          Effect.flatMap((response) => response.text.pipe(Effect.ignore, Effect.as(true))),
          Effect.catch(() => Effect.succeed(false)),
          Effect.provide(NodeHttpClient.layerNodeHttp),
        ),
        cleanupDetails,
      ).toBe(false);
    }).pipe(Effect.scoped),
  { timeout: 60000 },
);

it.effect(
  "retains metadata and tokens across disk-backed runtime restarts",
  () =>
    Effect.gen(function* () {
      const root = yield* makeTempDirectory("artifacts-persist-");
      const runtimeLayer = artifactsRuntimeLayer(Storage.layerDisk(root));
      const start = () =>
        startTestWorker({
          name: "artifacts-persist",
          compatibilityDate: "2026-09-03",
          compatibilityFlags: [],
          modules: [{ name: "main.js", type: "ESModule", content: script }],
          bindings: [Artifacts.local({ binding: "REPOS", namespace: "persist" })],
        });
      const created = yield* Effect.gen(function* () {
        const worker = yield* start();
        return yield* worker.fetchJson<{ id: string; token: string }>("/", {
          method: "POST",
          body: JSON.stringify({ op: "create" }),
        });
      }).pipe(Effect.provide(runtimeLayer), Effect.scoped);
      yield* Effect.gen(function* () {
        const worker = yield* start();
        const metadata = yield* worker.fetchJson<{ id: string; remote: string }>("/", {
          method: "POST",
          body: JSON.stringify({ op: "get" }),
        });
        expect(metadata.id).toBe(created.id);
        const response = yield* Effect.promise(() =>
          fetch(`${metadata.remote}/info/refs?service=git-upload-pack`, {
            headers: {
              Authorization: `Basic ${Buffer.from(`x-access-token:${created.token}`).toString("base64")}`,
            },
          }),
        );
        expect(response.status).toBe(200);
      }).pipe(Effect.provide(runtimeLayer), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);

// Native process shutdown and Windows storage-lock retries need wall-clock time.
it.live(
  "shares the Git backend across two live runtimes with separate listeners and concurrent bindings",
  () =>
    Effect.gen(function* () {
      const start = (name: string) =>
        startTestWorker({
          name,
          compatibilityDate: "2026-09-03",
          compatibilityFlags: [],
          modules: [{ name: "main.js", type: "ESModule", content: script }],
          // Registration is concurrent; both bindings must resolve to one service/socket.
          bindings: [
            Artifacts.local({ binding: "REPOS", namespace: "shared" }),
            Artifacts.local({ binding: "OTHER", namespace: "shared" }),
          ],
        });
      const firstScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const first = yield* start("artifacts-first").pipe(
        Effect.provideService(Scope.Scope, firstScope),
      );
      const created = yield* first.fetchJson<{ id: string; token: string; remote: string }>("/", {
        method: "POST",
        body: JSON.stringify({ op: "create" }),
      });
      const second = yield* start("artifacts-second");
      const metadata = yield* second.fetchJson<{ id: string; remote: string }>("/", {
        method: "POST",
        body: JSON.stringify({ op: "get" }),
      });
      expect(metadata.id).toBe(created.id);
      expect(metadata.remote).not.toBe(created.remote);
      yield* Scope.close(firstScope, Exit.void);
      // Closing the first workerd listener must leave the shared backend usable.

      for (const remote of [metadata.remote]) {
        const response = yield* Effect.promise(() =>
          fetch(`${remote}/info/refs?service=git-upload-pack`, {
            headers: {
              Authorization: `Basic ${Buffer.from(`x-access-token:${created.token}`).toString("base64")}`,
            },
          }),
        );
        expect(response.status).toBe(200);
        yield* Effect.promise(() => response.arrayBuffer());
      }
    }).pipe(Effect.scoped, Effect.provide(artifactsRuntimeLayer(Storage.layerTemp()))),
  { timeout: 60000 },
);

it("preserves a live import when another sidecar starts and cleans proven abandoned staging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "artifacts-owners-"));
  let accept!: () => void;
  let release!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const origin = createServer(async (_request, response) => {
    accept();
    await held;
    response.writeHead(503).end();
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const address = origin.address();
  if (!address || typeof address === "string") throw new Error("Expected origin port");
  const first = await startGitSidecar(root);
  let second: Awaited<ReturnType<typeof startGitSidecar>> | undefined;
  const importing = new GitClient(path.join(root, `${"a".repeat(32)}.git`))
    .importFrom(`http://127.0.0.1:${address.port}/source.git`)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  try {
    await accepted;
    const active = (await readdir(root)).find((name) =>
      name.startsWith(`.artifacts-import-${process.pid}-`),
    );
    expect(active).toBeDefined();
    // Obtain a PID which has actually exited, rather than guessing a free PID.
    const { stdout } = await exec(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))",
    ]);
    const abandoned = `.artifacts-stage-${stdout}-ABCDEF`;
    await mkdir(path.join(root, abandoned));
    second = await startGitSidecar(root);
    expect(await readdir(root)).toContain(active);
    expect(await readdir(root)).not.toContain(abandoned);
    await writeFile(path.join(root, active!, "still-owned"), "untouched");
  } finally {
    release();
    expect(await importing).toBeInstanceOf(Error);
    await second?.close();
    await first.close();
    origin.closeAllConnections();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
