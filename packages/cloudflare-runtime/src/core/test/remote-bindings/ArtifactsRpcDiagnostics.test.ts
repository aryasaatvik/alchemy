import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactRpcErrorFields,
  emitArtifactDiagnostic,
  relayArtifactDiagnostics,
} from "../../bindings/artifacts/ArtifactsDiagnostics.ts";
import Client from "../../remote-bindings/workers/client.worker.ts";

const { openSession } = vi.hoisted(() => ({ openSession: vi.fn() }));
vi.mock("capnweb", () => ({ newWebSocketRpcSession: openSession }));
vi.mock("cloudflare:workers", () => ({
  RpcTarget: class {},
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

const canary = "rpc-sensitive-reason-canary";
const event = {
  operation: "list",
  stage: "envelope",
  outcome: "failure",
  transport: "rpc",
};
const kinds = [
  ["Error", "error"],
  ["TypeError", "type-error"],
  ["AbortError", "abort"],
  ["TimeoutError", "timeout"],
] as const;
const capture = () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
  return () => lines.map((line) => JSON.parse(line.slice("[artifacts-rpc] ".length)));
};
const sinks = (value: unknown) => {
  emitArtifactDiagnostic(value);
  expect(relayArtifactDiagnostics({ diagnostics: [value] })).toBe(true);
};
const client = () =>
  new Client(
    { props: { binding: "ARTIFACTS", artifactsNamespace: "test" } } as ExecutionContext<{
      binding: string;
      artifactsNamespace: string;
    }>,
    {},
  ) as unknown as { list(): Promise<unknown> };

afterEach(() => {
  vi.restoreAllMocks();
  openSession.mockReset();
});

describe("Artifacts RPC rejection diagnostics", () => {
  it("classifies only own data names and preserves finite artifact error fields", () => {
    for (const [name, rpcErrorKind] of kinds) {
      expect(artifactRpcErrorFields({ name, code: "INTERNAL_ERROR", numericCode: 0 })).toEqual({
        rpcErrorKind,
        code: "INTERNAL_ERROR",
        numericCode: 0,
      });
    }
    for (const code of [
      "ALREADY_EXISTS",
      "NOT_FOUND",
      "CREATE_IN_PROGRESS",
      "IMPORT_IN_PROGRESS",
      "FORK_IN_PROGRESS",
      "INVALID_INPUT",
      "INVALID_REPO_NAME",
      "INVALID_TTL",
      "INVALID_URL",
      "REMOTE_AUTH_REQUIRED",
      "UPSTREAM_UNAVAILABLE",
      "MEMORY_LIMIT",
      "INTERNAL_ERROR",
    ]) {
      expect(artifactRpcErrorFields({ code, numericCode: 2_147_483_647 })).toEqual({
        rpcErrorKind: "unknown",
        code,
        numericCode: 2_147_483_647,
      });
    }
    for (const value of [
      undefined,
      null,
      false,
      42,
      "Error",
      new Error(canary),
      new TypeError(canary),
      { name: canary },
      { name: { toString: () => "Error" } },
      Object.create({ name: "Error", code: "INTERNAL_ERROR", numericCode: 1 }),
      { cause: { name: "Error", message: "WebSocket connection failed." } },
    ])
      expect(artifactRpcErrorFields(value)).toEqual({ rpcErrorKind: "unknown" });
    for (const numericCode of [-1, 2_147_483_648, 0.5, NaN, Infinity, "0"]) {
      expect(artifactRpcErrorFields({ numericCode, code: canary })).toEqual({
        rpcErrorKind: "unknown",
      });
    }
  });

  it("extracts bounded close codes while never returning the close reason", () => {
    for (const closeCode of [1000, 1001, 4000, 4999]) {
      for (const suffix of ["", ` ${canary}`, `: ${canary}`, `.${canary}`, `\n${canary}`]) {
        expect(
          artifactRpcErrorFields({ message: `Peer closed WebSocket: ${closeCode}${suffix}` }),
        ).toEqual({ rpcErrorKind: "unknown", closeCode });
      }
    }
    for (const message of [
      "Peer closed WebSocket: 0999",
      "Peer closed WebSocket: 5000",
      "Peer closed WebSocket: 10000",
      "Peer closed WebSocket: 100",
      "Peer closed WebSocket: -1000",
      "Peer closed WebSocket: 1e03",
      "Peer closed WebSocket: 1000x",
      "Peer closed WebSocket: 1000_",
      "Peer closed WebSocket:  1000",
      "peer closed WebSocket: 1000",
      "prefix Peer closed WebSocket: 1000",
      "\nPeer closed WebSocket: 1000",
      1000,
      null,
      new String("Peer closed WebSocket: 1000"),
    ])
      expect(artifactRpcErrorFields({ message })).toEqual({ rpcErrorKind: "unknown" });
  });

  it("recognizes only the exact connection failure message", () => {
    expect(
      artifactRpcErrorFields({ name: "Error", message: "WebSocket connection failed." }),
    ).toEqual({ rpcErrorKind: "error", connectionFailed: true });
    for (const message of [
      "WebSocket connection failed",
      "webSocket connection failed.",
      " WebSocket connection failed.",
      "WebSocket connection failed. ",
      "WebSocket connection failed.\n",
      `WebSocket connection failed. ${canary}`,
    ])
      expect(artifactRpcErrorFields({ message })).toEqual({ rpcErrorKind: "unknown" });
  });

  it("does not read accessors, prototypes, coercions, or unrelated rejection fields", () => {
    let reads = 0;
    const trapped = {};
    for (const key of ["name", "message", "code", "numericCode", "reason", "cause", "stack"]) {
      Object.defineProperty(trapped, key, {
        get() {
          reads++;
          throw new Error(canary);
        },
      });
    }
    expect(artifactRpcErrorFields(trapped)).toEqual({ rpcErrorKind: "unknown" });
    expect(
      artifactRpcErrorFields(
        Object.create({
          name: "Error",
          message: "Peer closed WebSocket: 1000 secret",
          code: "INTERNAL_ERROR",
        }),
      ),
    ).toEqual({ rpcErrorKind: "unknown" });
    const forged = {
      toString() {
        reads++;
        throw new Error(canary);
      },
    };
    expect(
      artifactRpcErrorFields({ name: forged, message: forged, code: forged, numericCode: forged }),
    ).toEqual({ rpcErrorKind: "unknown" });
    const data = new Proxy(
      { name: "AbortError", message: `Peer closed WebSocket: 4001 ${canary}` },
      {
        get() {
          throw new Error(canary);
        },
        ownKeys() {
          throw new Error(canary);
        },
        getPrototypeOf() {
          throw new Error(canary);
        },
      },
    );
    expect(artifactRpcErrorFields(data)).toEqual({ rpcErrorKind: "abort", closeCode: 4001 });
    expect(reads).toBe(0);
  });

  it("tolerates descriptor traps and revoked proxies", () => {
    const trapped = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error(canary);
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [trapped, revoked.proxy]) {
      expect(artifactRpcErrorFields(value)).toEqual({ rpcErrorKind: "unknown" });
    }
    const partial = new Proxy(
      { name: "TimeoutError", code: "INTERNAL_ERROR" },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "message") throw new Error(canary);
          return Object.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(artifactRpcErrorFields(partial)).toEqual({
      rpcErrorKind: "timeout",
      code: "INTERNAL_ERROR",
    });
  });

  it("pins both message templates in the actual installed Cap'n Web distribution", () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(require.resolve("capnweb"), "utf8");
    // Pin the producer's templates, so a dependency change cannot silently disable classification.
    expect(source).toContain("new Error(`Peer closed WebSocket: ${event.code} ${event.reason}`)");
    expect(source).toContain("new Error(`WebSocket connection failed.`)");
    expect(artifactRpcErrorFields(new Error(`Peer closed WebSocket: 4000 ${canary}`))).toEqual({
      rpcErrorKind: "unknown",
      closeCode: 4000,
    });
    expect(artifactRpcErrorFields(new Error("WebSocket connection failed."))).toEqual({
      rpcErrorKind: "unknown",
      connectionFailed: true,
    });
  });

  it("validates every RPC field at emission and relay and strips sensitive text", () => {
    const logs = capture();
    for (const rpcErrorKind of [...kinds.map(([, kind]) => kind), "unknown"]) {
      for (const closeCode of [1000, 4999]) {
        const finite = {
          ...event,
          rpcErrorKind,
          closeCode,
          connectionFailed: true,
          code: "INTERNAL_ERROR",
          numericCode: 0,
        };
        sinks({ ...finite, message: canary, reason: canary, stack: canary });
        expect(logs().slice(-2)).toEqual([finite, finite]);
      }
    }
    const finite = { ...event, rpcErrorKind: "error", closeCode: 4000, connectionFailed: true };
    expect(
      relayArtifactDiagnostics(JSON.stringify({ diagnostics: [{ ...finite, reason: canary }] })),
    ).toBe(true);
    expect(logs().at(-1)).toEqual(finite);
    expect(JSON.stringify(logs())).not.toContain(canary);
  });

  it("drops malformed RPC fields independently at both sinks", () => {
    const logs = capture();
    for (const closeCode of [999, 5000, -1, 1000.5, NaN, Infinity, "1000", null]) {
      sinks({ ...event, closeCode, rpcErrorKind: "error", connectionFailed: true });
      expect(logs().slice(-2)).toEqual(
        Array(2).fill({ ...event, rpcErrorKind: "error", connectionFailed: true }),
      );
    }
    for (const rpcErrorKind of ["Error", canary, 1, null, {}]) {
      sinks({ ...event, rpcErrorKind, closeCode: 1000 });
      expect(logs().slice(-2)).toEqual(Array(2).fill({ ...event, closeCode: 1000 }));
    }
    for (const connectionFailed of [false, 1, "true", null, {}]) {
      sinks({ ...event, connectionFailed });
      expect(logs().slice(-2)).toEqual([event, event]);
    }
  });

  it("ignores inherited and accessor fields and contains throwing proxies at both sinks", () => {
    const logs = capture();
    let reads = 0;
    const value = { ...event };
    for (const key of ["rpcErrorKind", "closeCode", "connectionFailed", "message", "reason"]) {
      Object.defineProperty(value, key, {
        get() {
          reads++;
          throw new Error(canary);
        },
      });
    }
    sinks(value);
    sinks(
      Object.assign(
        Object.create({ rpcErrorKind: "error", closeCode: 1000, connectionFailed: true }),
        event,
      ),
    );
    expect(logs()).toEqual([event, event, event, event]);
    expect(reads).toBe(0);
    const trapped = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error(canary);
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const hostile of [trapped, revoked.proxy]) {
      sinks(hostile);
      emitArtifactDiagnostic({
        ...event,
        rpcErrorKind: hostile,
        closeCode: hostile,
        connectionFailed: hostile,
      });
      expect(logs().at(-1)).toEqual(event);
    }
    expect(JSON.stringify(logs())).not.toContain(canary);
  });

  it("keeps logging failures observational", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error(canary);
    });
    expect(() =>
      sinks({ ...event, ...artifactRpcErrorFields({ message: "WebSocket connection failed." }) }),
    ).not.toThrow();
  });
});

describe("Artifacts client RPC catches", () => {
  it("rethrows the identical session-open error and emits finite fields", async () => {
    const logs = capture();
    const error = {
      name: "TypeError",
      message: `Peer closed WebSocket: 4000 ${canary}`,
      code: "INTERNAL_ERROR",
      numericCode: 7,
    };
    openSession.mockImplementation(() => {
      throw error;
    });
    await expect(client().list()).rejects.toBe(error);
    expect(logs()).toEqual([
      { operation: "list", stage: "session-open", outcome: "begin" },
      {
        operation: "list",
        stage: "session-open",
        outcome: "failure",
        transport: "rpc",
        rpcErrorKind: "type-error",
        closeCode: 4000,
        code: "INTERNAL_ERROR",
        numericCode: 7,
      },
    ]);
    expect(JSON.stringify(logs())).not.toContain(canary);
  });

  it("rethrows the identical settlement rejection, emits envelope fields, and disposes", async () => {
    const logs = capture();
    const error = { name: "Error", message: "WebSocket connection failed.", reason: canary };
    const dispose = vi.fn();
    openSession.mockReturnValue({ list: () => Promise.reject(error), [Symbol.dispose]: dispose });
    await expect(client().list()).rejects.toBe(error);
    expect(dispose).toHaveBeenCalledOnce();
    expect(logs().filter((entry) => entry.outcome === "failure")).toEqual([
      { ...event, rpcErrorKind: "error", connectionFailed: true },
    ]);
    expect(logs().at(-1)).toEqual({
      operation: "list",
      stage: "session-dispose",
      outcome: "success",
    });
    expect(JSON.stringify(logs())).not.toContain(canary);
  });

  it("preserves the identical session-dispose error and its precedence over settlement failure", async () => {
    const logs = capture();
    const error = { name: "TimeoutError", message: `Peer closed WebSocket: 4999 ${canary}` };
    const rejection = { name: "AbortError", message: "WebSocket connection failed." };
    openSession.mockReturnValue({
      list: () => Promise.reject(rejection),
      [Symbol.dispose]: () => {
        throw error;
      },
    });
    await expect(client().list()).rejects.toBe(error);
    expect(logs().filter((entry) => entry.outcome === "failure")).toEqual([
      { ...event, rpcErrorKind: "abort", connectionFailed: true },
      { ...event, stage: "session-dispose", rpcErrorKind: "timeout", closeCode: 4999 },
    ]);
    expect(JSON.stringify(logs())).not.toContain(canary);
  });
});
