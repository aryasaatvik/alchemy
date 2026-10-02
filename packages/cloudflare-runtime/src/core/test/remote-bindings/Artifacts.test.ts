import { describe, expect, it } from "@effect/vitest";
import { newMessagePortRpcSession } from "capnweb";

import makeArtifactsBinding from "../../bindings/artifacts/artifacts.worker.ts";
import {
  ArtifactsBindingProxy,
  type ArtifactsRepositoryMetadataResult,
  type ArtifactsRepositoryWireOperations,
} from "../../bindings/artifacts/ArtifactsRpc.ts";

// The remote half (`ArtifactsBindingProxy`) runs behind Cap'n Web in the
// preview worker; the local half (`artifacts.worker.ts`) wraps the
// remote-bindings client inside workerd. These tests drive the remote half
// over a real Cap'n Web session and the local half against a stand-in client.

const repositoryInfo = (name: string) => ({
  id: `${name}-id`,
  name,
  description: null,
  defaultBranch: "main",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastPushAt: null,
  source: null,
  readOnly: false,
});

const notUsed = async (): Promise<never> => {
  throw new Error("not used");
};

const makeRepository = (calls: Array<unknown>) =>
  ({
    ...repositoryInfo("starter"),
    remote: "https://example.com/starter.git",
    createToken: async (scope?: "write" | "read", ttl?: number) => {
      calls.push(["createToken", scope, ttl]);
      return {
        id: "token-id",
        plaintext: "secret",
        scope: scope ?? "write",
        expiresAt: "2026-09-01T01:00:00.000Z",
      };
    },
    listTokens: async () => ({ tokens: [], total: 0 }),
    revokeToken: async (tokenOrId: string) => {
      calls.push(["revokeToken", tokenOrId]);
      return true;
    },
    fork: notUsed,
  }) satisfies ArtifactsRepo;

const makeArtifacts = (overrides: Partial<Artifacts>): Artifacts => ({
  create: notUsed,
  get: notUsed,
  import: notUsed,
  list: async () => ({ repos: [], total: 0 }),
  delete: async () => false,
  ...overrides,
});

type RemoteArtifacts = {
  getMetadata(name: string): Promise<ArtifactsRepositoryMetadataResult>;
  getMethods(name: string): Promise<ArtifactsRepositoryWireOperations>;
  list(options?: Parameters<Artifacts["list"]>[0]): Promise<string>;
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

describe("Artifacts remote binding", () => {
  it("rebuilds the Git remote from repository-list metadata", async () => {
    const pages = [
      { repos: [repositoryInfo("other")], total: 2, cursor: "page-2" },
      { repos: [repositoryInfo("starter")], total: 2 },
    ];
    const cursors: Array<string | undefined> = [];
    using session = connect(
      new ArtifactsBindingProxy(
        makeArtifacts({
          list: async (options) => {
            cursors.push(options?.cursor);
            return pages[cursors.length - 1]!;
          },
        }),
        "account-id",
        "samva-templates-development",
      ),
    );

    const result = await session.client.getMetadata("starter");

    expect(cursors).toEqual([undefined, "page-2"]);
    expect(result).toEqual({
      ok: true,
      metadata: {
        ...repositoryInfo("starter"),
        remote:
          "https://account-id.artifacts.cloudflare.net/git/samva-templates-development/starter.git",
      },
    });
  });

  it("returns a missing repository as a structured Artifacts error", async () => {
    using session = connect(
      new ArtifactsBindingProxy(makeArtifacts({}), "account-id", "ns"),
    );

    expect(await session.client.getMetadata("missing")).toEqual({
      ok: false,
      error: {
        name: "ArtifactsError",
        message: "Repository not found: missing.",
        code: "NOT_FOUND",
        numericCode: 10_001,
      },
    });
  });

  it("keeps the code of an Artifacts error thrown by the binding", async () => {
    using session = connect(
      new ArtifactsBindingProxy(
        makeArtifacts({
          list: async () => {
            throw Object.assign(new Error("Upstream unavailable."), {
              name: "ArtifactsError",
              code: "UPSTREAM_UNAVAILABLE",
              numericCode: 10_503,
            });
          },
        }),
        "account-id",
        "ns",
      ),
    );

    expect(await session.client.getMetadata("starter")).toEqual({
      ok: false,
      error: {
        name: "ArtifactsError",
        message: "Upstream unavailable.",
        code: "UPSTREAM_UNAVAILABLE",
        numericCode: 10_503,
      },
    });
  });

  it("delegates repository methods and serializes their records", async () => {
    const calls: Array<unknown> = [];
    using session = connect(
      new ArtifactsBindingProxy(
        makeArtifacts({ get: async () => makeRepository(calls) }),
      ),
    );

    using methods = await session.client.getMethods("starter");
    const token = JSON.parse(await methods.createToken("read", 3_600));

    expect(token).toMatchObject({ id: "token-id", plaintext: "secret" });
    expect(await methods.revokeToken("token-id")).toBe(true);
    expect(calls).toEqual([
      ["createToken", "read", 3_600],
      ["revokeToken", "token-id"],
    ]);
  });

  it("serializes binding records", async () => {
    using session = connect(
      new ArtifactsBindingProxy(
        makeArtifacts({
          list: async () => ({ repos: [repositoryInfo("starter")], total: 1 }),
        }),
      ),
    );

    expect(JSON.parse(await session.client.list({ limit: 1 }))).toEqual({
      repos: [repositoryInfo("starter")],
      total: 1,
    });
  });
});

describe("Artifacts local wrapper", () => {
  const metadata = {
    ...repositoryInfo("starter"),
    remote: "https://example.com/starter.git",
  };

  it("hydrates a repository from its metadata and methods", async () => {
    const calls: Array<unknown> = [];
    const repository = makeRepository(calls);
    const binding = makeArtifactsBinding({
      proxyClient: {
        ...makeArtifacts({}),
        artifactsGetMetadata: async () => ({ ok: true, metadata }),
        artifactsGetMethods: async () => repository,
      },
    });

    const hydrated = await binding.get("starter");

    expect(hydrated).toMatchObject(metadata);
    expect((await hydrated.createToken("write")).id).toBe("token-id");
    expect(calls).toEqual([["createToken", "write", undefined]]);
  });

  it("rethrows a remote failure with its Artifacts error code", async () => {
    const binding = makeArtifactsBinding({
      proxyClient: {
        ...makeArtifacts({}),
        artifactsGetMetadata: async () => ({
          ok: false,
          error: {
            name: "ArtifactsError",
            message: "Repository not found: missing.",
            code: "NOT_FOUND",
            numericCode: 10_001,
          },
        }),
        artifactsGetMethods: notUsed,
      },
    });

    const error = await binding.get("missing").catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "ArtifactsError",
      message: "Repository not found: missing.",
      code: "NOT_FOUND",
      numericCode: 10_001,
    });
  });
});
