import { describe, expect, it } from "@effect/vitest";
import { newMessagePortRpcSession } from "capnweb";

import {
  ArtifactsBindingProxy,
  exposeArtifactsRepository,
  hydrateArtifactsRepository,
  type ArtifactsRepositoryMetadataResult,
  type ArtifactsRepositoryWire,
} from "../../bindings/ArtifactsRpc.ts";

describe("Artifacts remote binding", () => {
  it("projects repository metadata by value and delegates methods", async () => {
    const calls: Array<unknown> = [];
    const repository = {
      id: "repo-id",
      name: "starter",
      description: "Starter repository",
      defaultBranch: "main",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      lastPushAt: null,
      source: null,
      readOnly: false,
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
      fork: async (name: string) => {
        calls.push(["fork", name]);
        return {
          id: "fork-id",
          name,
          description: null,
          defaultBranch: "main",
          remote: `https://example.com/${name}.git`,
          token: "secret",
          tokenExpiresAt: "2026-09-01T01:00:00.000Z",
        };
      },
    } satisfies ArtifactsRepo;

    const exposed = exposeArtifactsRepository(repository);

    expect(exposed.metadata.remote).toBe("https://example.com/starter.git");
    expect(typeof exposed.methods.createToken).toBe("function");
    await exposed.methods.createToken("read", 3_600);
    await exposed.methods.revokeToken("token-id");
    await exposed.methods.fork("forked");
    expect(calls).toEqual([
      ["createToken", "read", 3_600],
      ["revokeToken", "token-id"],
      ["fork", "forked"],
    ]);
  });

  it("preserves repository metadata and methods across Cap'n Web", async () => {
    const calls: Array<unknown> = [];
    const repository = {
      id: "repo-id",
      name: "starter",
      description: null,
      defaultBranch: "main",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      lastPushAt: null,
      source: null,
      readOnly: false,
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
      revokeToken: async () => true,
      fork: async (name: string) => ({
        id: "fork-id",
        name,
        description: null,
        defaultBranch: "main",
        remote: `https://example.com/${name}.git`,
        token: "secret",
        tokenExpiresAt: "2026-09-01T01:00:00.000Z",
      }),
    } satisfies ArtifactsRepo;
    const binding = {
      create: async () => {
        throw new Error("not used");
      },
      get: async () => repository,
      import: async () => {
        throw new Error("not used");
      },
      list: async () => ({ repos: [], total: 0 }),
      delete: async () => false,
    } satisfies Artifacts;
    const channel = new MessageChannel();

    using server = newMessagePortRpcSession(
      channel.port1,
      new ArtifactsBindingProxy(binding),
    );
    using client = newMessagePortRpcSession<{
      get(name: string): Promise<ArtifactsRepositoryWire>;
    }>(channel.port2);

    const exposed = hydrateArtifactsRepository(await client.get("starter"));

    expect(exposed.remote).toBe("https://example.com/starter.git");
    const credential = await exposed.createToken("read", 3_600);
    expect(credential.id).toBe("token-id");
    expect(credential.plaintext).toBe("secret");
    expect(calls).toEqual([["createToken", "read", 3_600]]);
  });

  it("preserves structured Artifacts errors across Cap'n Web", async () => {
    const notFound = Object.assign(
      new Error("Repository not found: missing."),
      {
        name: "ArtifactsError" as const,
        code: "NOT_FOUND" as const,
        numericCode: 10_001,
      },
    );
    const binding = {
      create: async () => {
        throw new Error("not used");
      },
      get: async () => {
        throw notFound;
      },
      import: async () => {
        throw new Error("not used");
      },
      list: async () => ({ repos: [], total: 0 }),
      delete: async () => false,
    } satisfies Artifacts;
    const channel = new MessageChannel();

    using server = newMessagePortRpcSession(
      channel.port1,
      new ArtifactsBindingProxy(binding),
    );
    using client = newMessagePortRpcSession<{
      getMetadata(name: string): Promise<ArtifactsRepositoryMetadataResult>;
    }>(channel.port2);

    const result = await client.getMetadata("missing");

    expect(result).toEqual({
      ok: false,
      error: {
        name: "ArtifactsError",
        message: "Repository not found: missing.",
        code: "NOT_FOUND",
        numericCode: 10_001,
      },
    });
  });
});
