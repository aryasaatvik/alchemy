import { describe, expect, it } from "@effect/vitest";
import { newMessagePortRpcSession } from "capnweb";

import {
  ArtifactsBindingProxy,
  exposeArtifactsRepository,
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

    expect(exposed.remote).toBe("https://example.com/starter.git");
    expect(typeof exposed.createToken).toBe("function");
    await exposed.createToken("read", 3_600);
    await exposed.revokeToken("token-id");
    await exposed.fork("forked");
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
    using client = newMessagePortRpcSession<Artifacts>(channel.port2);

    const exposed = await client.get("starter");

    expect(exposed.remote).toBe("https://example.com/starter.git");
    await exposed.createToken("read", 3_600);
    expect(calls).toEqual([["createToken", "read", 3_600]]);
  });
});
