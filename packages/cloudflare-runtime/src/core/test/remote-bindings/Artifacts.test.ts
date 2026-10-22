import { describe, expect, it } from "@effect/vitest";
import { newMessagePortRpcSession } from "capnweb";
import { vi } from "vitest";
import makeArtifactsBinding from "../../bindings/artifacts/artifacts.worker.ts";
import {
  artifactErrorFields,
  emitArtifactDiagnostic,
  relayArtifactDiagnostics,
  ArtifactsDiagnostics,
} from "../../bindings/artifacts/ArtifactsDiagnostics.ts";
import {
  ArtifactsBindingProxy,
  type ArtifactsRepositoryMetadataResult,
  type ArtifactsRepositoryWireOperations,
} from "../../bindings/artifacts/ArtifactsRpc.ts";

const notUsed = async (): Promise<never> => {
  throw new Error("Unscripted Artifacts operation");
};
const metadata: ArtifactsRepoInfo = {
  id: "starter-id",
  name: "starter",
  description: null,
  defaultBranch: "main",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastPushAt: null,
  source: null,
  readOnly: false,
  remote: "https://account-id.artifacts.cloudflare.net/git/ns/starter.git",
};
const commit: ArtifactsCommitMetadata = {
  hash: "a".repeat(40),
  treeHash: "b".repeat(40),
  message: "Initial commit",
  author: { name: "Fixture", email: "fixture@example.test" },
  committer: { name: "Fixture", email: "fixture@example.test" },
  parents: [],
  authoredAt: 1,
  committedAt: 1,
};
const tree: ArtifactsTreeEntry[] = [
  { name: "fixture.bin", mode: "100644", hash: "c".repeat(40), type: "blob" },
];
const bytes = new Uint8Array([0, 255, 195, 169, 10]);

const fixture = () => {
  let info = metadata;
  let disposed = 0;
  const calls: unknown[] = [];
  const repository: ArtifactsRepo = {
    [Symbol.dispose]: () => {
      disposed++;
    },
    info: async () => info,
    createToken: async (scope, ttl) => {
      calls.push(["createToken", scope, ttl]);
      return {
        id: "token-id",
        plaintext: "secret",
        scope: scope ?? "write",
        expiresAt: "2026-09-01T01:00:00.000Z",
      };
    },
    listTokens: async () => ({ tokens: [], total: 0 }),
    revokeToken: async (id) => {
      calls.push(["revokeToken", id]);
      return true;
    },
    fork: async (name) => ({
      id: "fork-id",
      name,
      description: null,
      defaultBranch: "main",
      remote: "https://example.test/fork.git",
      token: "fork-token",
    }),
    readBlob: async (hash) => (hash === "missing" ? null : new Blob([bytes])),
    readFile: async (args) => {
      calls.push(["readFile", args]);
      if (args.path === "invalid")
        throw Object.assign(new Error("Invalid file path"), {
          name: "ArtifactsError",
          code: "INVALID_INPUT",
          numericCode: 10002,
        });
      return args.path === "missing"
        ? null
        : new Blob([bytes], { type: "application/octet-stream" });
    },
    readTree: async () => tree,
    readCommit: async () => commit,
    log: async (options) => {
      calls.push(["log", options]);
      return [commit];
    },
  };
  const binding: Artifacts = {
    create: notUsed,
    import: notUsed,
    list: notUsed,
    delete: notUsed,
    get: async (name) => {
      if (name === "missing")
        throw Object.assign(new Error("Repository not found: missing."), {
          name: "ArtifactsError",
          code: "NOT_FOUND",
          numericCode: 10001,
        });
      return repository;
    },
  };
  return {
    binding,
    calls,
    get disposed() {
      return disposed;
    },
    updateInfo(value: ArtifactsRepoInfo) {
      info = value;
    },
  };
};

type RemoteArtifacts = {
  getMetadata(name: string, diagnostics?: boolean): Promise<ArtifactsRepositoryMetadataResult>;
  getMethods(name: string, diagnostics?: boolean): Promise<ArtifactsRepositoryWireOperations>;
};
const connect = (proxy: ArtifactsBindingProxy) => {
  const channel = new MessageChannel();
  const server = newMessagePortRpcSession(channel.port1, proxy);
  const client = newMessagePortRpcSession<RemoteArtifacts>(channel.port2);
  return {
    client,
    [Symbol.dispose]: () => {
      client[Symbol.dispose]();
      server[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    },
  };
};
const value = (json: string) => JSON.parse(json).value;

// The remote half crosses real Cap'n Web; the facade then rebuilds native values.
describe("Artifacts remote binding", () => {
  it("reads fresh native info and disposes every repository capability", async () => {
    const api = fixture();
    using session = connect(new ArtifactsBindingProxy(api.binding));
    expect(await session.client.getMetadata("starter")).toEqual({ ok: true, metadata });
    expect(api.disposed).toBe(1);
    using methods = await session.client.getMethods("starter");
    api.updateInfo({ ...metadata, description: "changed" });
    expect(value(await methods.info())).toEqual({ ...metadata, description: "changed" });
    expect(value(await methods.createToken("read", 3600))).toMatchObject({
      id: "token-id",
      scope: "read",
    });
    expect(value(await methods.revokeToken("token-id"))).toBe(true);
    expect(api.disposed).toBe(4);
    expect(api.calls).toEqual([
      ["createToken", "read", 3600],
      ["revokeToken", "token-id"],
    ]);
  });

  it("keeps native get errors structured instead of inventing list metadata", async () => {
    const api = fixture();
    using session = connect(new ArtifactsBindingProxy(api.binding));
    expect(await session.client.getMetadata("missing")).toEqual({
      ok: false,
      error: {
        name: "ArtifactsError",
        message: "Repository not found: missing.",
        code: "NOT_FOUND",
        numericCode: 10001,
      },
    });
    expect(api.disposed).toBe(0);
  });

  it("serializes Git records, blob bytes, missing values and operation errors", async () => {
    const api = fixture();
    using session = connect(new ArtifactsBindingProxy(api.binding));
    using methods = await session.client.getMethods("starter");
    expect(value(await methods.readTree("tree"))).toEqual(tree);
    expect(value(await methods.readCommit("commit"))).toEqual(commit);
    expect(value(await methods.log({ ref: "main", limit: 2, offset: 1 }))).toEqual([commit]);
    expect(value(await methods.readBlob("blob"))).toEqual({
      base64: btoa(String.fromCharCode(...bytes)),
      type: "",
    });
    expect(value(await methods.readBlob("missing"))).toBeNull();
    expect(value(await methods.readFile({ ref: "main", path: "fixture.bin" }))).toEqual({
      base64: btoa(String.fromCharCode(...bytes)),
      type: "application/octet-stream",
    });
    expect(JSON.parse(await methods.readFile({ ref: "main", path: "invalid" }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", numericCode: 10002 },
    });
    expect(api.disposed).toBe(7);
  });
});

describe("Artifacts local facade", () => {
  const local = (api: ReturnType<typeof fixture>) => {
    const remote = new ArtifactsBindingProxy(api.binding);
    let disposed = false;
    const binding = makeArtifactsBinding({
      proxyClient: {
        create: remote.create.bind(remote),
        import: remote.import.bind(remote),
        list: remote.list.bind(remote),
        delete: remote.delete.bind(remote),
        artifactsGetMetadata: remote.getMetadata.bind(remote),
        artifactsGetMethods: async (name) =>
          Object.assign(await remote.getMethods(name), {
            [Symbol.dispose]: () => {
              disposed = true;
            },
          }),
      },
    });
    return {
      binding,
      get disposed() {
        return disposed;
      },
    };
  };

  it("exposes the full native API, reconstructs Blobs and disposes its local methods stub", async () => {
    const api = fixture();
    const facade = local(api);
    const repository = await facade.binding.get("starter");
    expect(await repository.info()).toEqual(metadata);
    api.updateInfo({ ...metadata, description: "fresh" });
    expect((await repository.info()).description).toBe("fresh");
    expect((await repository.createToken("write")).id).toBe("token-id");
    expect(await repository.listTokens()).toEqual({ tokens: [], total: 0 });
    expect(await repository.revokeToken("token-id")).toBe(true);
    expect((await repository.fork("copy")).name).toBe("copy");
    expect(await repository.readTree("tree")).toEqual(tree);
    expect(await repository.readCommit("commit")).toEqual(commit);
    expect(await repository.log({ ref: "main" })).toEqual([commit]);
    const blob = await repository.readBlob("blob");
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
    const file = await repository.readFile({ ref: "main", path: "fixture.bin" });
    expect(file!.type).toBe("application/octet-stream");
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(bytes);
    expect(await repository.readBlob("missing")).toBeNull();
    expect(await repository.readFile({ ref: "main", path: "missing" })).toBeNull();
    await expect(repository.readFile({ ref: "main", path: "invalid" })).rejects.toMatchObject({
      name: "ArtifactsError",
      code: "INVALID_INPUT",
      numericCode: 10002,
    });
    repository[Symbol.dispose]();
    expect(facade.disposed).toBe(true);
    expect(api.disposed).toBe(15);
  });

  it("rethrows native get errors with their Artifacts code", async () => {
    const facade = local(fixture());
    await expect(facade.binding.get("missing")).rejects.toMatchObject({
      name: "ArtifactsError",
      code: "NOT_FOUND",
      numericCode: 10001,
    });
  });
});

describe("Artifacts diagnostic safety", () => {
  it("does not reflect getters, coerce hostile values, or throw on revoked capabilities", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    let getters = 0;
    const hostile = {
      get code() {
        getters++;
        throw new Error("sensitive-getter-canary");
      },
      get numericCode() {
        getters++;
        throw new Error("sensitive-getter-canary");
      },
    };
    const trap = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("sensitive-trap-canary");
        },
      },
    );
    const coercion = {
      [Symbol.toPrimitive]() {
        throw new Error("sensitive-coercion-canary");
      },
    };
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(line);
    });
    try {
      for (const value of [revoked.proxy, trap, hostile, null, coercion]) {
        expect(() => artifactErrorFields(value)).not.toThrow();
        expect(artifactErrorFields(value)).toEqual({});
        expect(() => emitArtifactDiagnostic(value)).not.toThrow();
        expect(() => relayArtifactDiagnostics(value)).not.toThrow();
      }
      for (const value of [
        coercion,
        revoked.proxy,
        NaN,
        Infinity,
        -1,
        2_147_483_648,
        "sensitive-code-canary",
      ]) {
        expect(artifactErrorFields({ code: value, numericCode: value })).toEqual({});
        emitArtifactDiagnostic({
          operation: "session",
          stage: "forward",
          outcome: "failure",
          httpStatus: value,
          upgrade: value,
          message: "sensitive-message-canary",
        });
      }
      emitArtifactDiagnostic({
        operation: "session",
        stage: "forward",
        outcome: "success",
        get httpStatus() {
          getters++;
          throw new Error("sensitive-status-canary");
        },
      });
      expect(getters).toBe(0);
      expect(JSON.stringify(lines)).not.toMatch(/sensitive|httpStatus|upgrade/);
      log.mockImplementation(() => {
        throw new Error("sensitive-sink-canary");
      });
      expect(() =>
        emitArtifactDiagnostic({ operation: "createToken", stage: "dispatch", outcome: "begin" }),
      ).not.toThrow();
      const error = revoked.proxy;
      const trace = new ArtifactsDiagnostics("createToken");
      await expect(
        trace.run("native-createToken", async () => {
          throw error;
        }),
      ).rejects.toBe(error);
    } finally {
      log.mockRestore();
    }
  });

  it("relays at most the finite sidecar and excludes business values and unallowlisted fields", () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(line);
    });
    try {
      const event = {
        operation: "createToken",
        stage: "native-createToken",
        outcome: "failure",
        origin: "native",
        code: "INVALID_TTL",
        numericCode: 10003,
        message: "sensitive-message-canary",
        body: "sensitive-body-canary",
      };
      expect(
        relayArtifactDiagnostics(
          JSON.stringify({
            ok: true,
            value: { plaintext: "sensitive-token-canary" },
            diagnostics: Array(100).fill(event),
          }),
        ),
      ).toBe(true);
      expect(lines).toHaveLength(16);
      expect(JSON.parse(lines[0].slice("[artifacts-rpc] ".length))).toEqual({
        operation: "createToken",
        stage: "native-createToken",
        outcome: "failure",
        origin: "native",
        code: "INVALID_TTL",
        numericCode: 10003,
      });
      expect(lines.join("")).not.toMatch(/sensitive|message|body|plaintext/);
      expect(relayArtifactDiagnostics('{"ok":')).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  for (const mode of ["typed", "json", "dispose", "both", "internal", "unallowlisted"])
    it(`keeps original error envelopes and disposal behavior across Cap'n Web: ${mode}`, async () => {
      const api = fixture();
      const repository = await api.binding.get("starter");
      const tokenError = Object.assign(new Error("sensitive-original-canary"), {
        code:
          mode === "internal"
            ? "INTERNAL_ERROR"
            : mode === "unallowlisted"
              ? "sensitive-code-canary"
              : "INVALID_TTL",
        numericCode: 10003,
      });
      const disposeError = new Error("sensitive-disposal-canary");
      const originalDispose = repository[Symbol.dispose].bind(repository);
      const order: string[] = [];
      Object.assign(repository, {
        createToken: async () => {
          order.push("settled");
          if (
            mode === "typed" ||
            mode === "both" ||
            mode === "internal" ||
            mode === "unallowlisted"
          )
            throw tokenError;
          return {
            id: "token-id",
            plaintext: "sensitive-token-canary",
            scope: "read",
            expiresAt: "now",
            toJSON() {
              throw new Error("sensitive-json-canary");
            },
          };
        },
        [Symbol.dispose]: () => {
          order.push("dispose");
          originalDispose();
          if (mode === "dispose" || mode === "both") throw disposeError;
        },
      });
      using session = connect(new ArtifactsBindingProxy(api.binding));
      using original = await session.client.getMethods("starter");
      using traced = await session.client.getMethods("starter", true);
      const before = JSON.parse(await original.createToken("read", 60));
      const { diagnostics, ...after } = JSON.parse(await traced.createToken("read", 60));
      expect(after).toEqual(before);
      expect(api.disposed).toBe(2);
      expect(order).toEqual(["settled", "dispose", "settled", "dispose"]);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: "native-createToken",
            outcome:
              mode === "typed" || mode === "both" || mode === "internal" || mode === "unallowlisted"
                ? "failure"
                : "success",
          }),
          expect.objectContaining({
            stage: "native-dispose",
            outcome: mode === "dispose" || mode === "both" ? "failure" : "success",
          }),
        ]),
      );
      if (mode === "internal" || mode === "unallowlisted")
        expect(diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ stage: "envelope", origin: "native" }),
          ]),
        );
      expect(JSON.stringify(diagnostics)).not.toMatch(/sensitive|message|stack|token-id/);
    });
});
