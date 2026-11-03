import { execFile } from "node:child_process";
import { readdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Artifacts from "../../bindings/artifacts/Artifacts.ts";
import { gitEnvironment } from "../../bindings/artifacts/git-client.ts";
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

it.effect(
  "closes listeners and removes temporary repository state with the runtime scope",
  () =>
    Effect.gen(function* () {
      let remote = "";
      const storageLayer = Storage.layerTemp();
      const runtimeLayer = artifactsRuntimeLayer(storageLayer);
      const root = yield* Effect.gen(function* () {
        const storage = yield* Storage.Storage;
        if (!("disk" in storage) || !storage.disk) throw new Error("Expected disk storage");
        const worker = yield* startTestWorker({
          name: "artifacts-cleanup",
          compatibilityDate: "2026-09-03",
          compatibilityFlags: [],
          modules: [{ name: "main.js", type: "ESModule", content: script }],
          bindings: [Artifacts.local({ binding: "REPOS", namespace: "cleanup" })],
        });
        const created = yield* worker.fetchJson<{ remote: string }>("/", {
          method: "POST",
          body: JSON.stringify({ op: "create" }),
        });
        remote = created.remote;
        expect(
          yield* Effect.promise(() =>
            readdir(`${storage.disk.path}/artifacts`, { recursive: true }),
          ),
        ).toContainEqual(expect.stringMatching(/\.git\/HEAD$/));
        return storage.disk.path;
      }).pipe(Effect.provide(runtimeLayer), Effect.scoped);
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
      ).toBe(false);
      expect(
        yield* Effect.promise(() =>
          fetch(`${remote}/info/refs?service=git-upload-pack`).then(
            () => true,
            () => false,
          ),
        ),
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
