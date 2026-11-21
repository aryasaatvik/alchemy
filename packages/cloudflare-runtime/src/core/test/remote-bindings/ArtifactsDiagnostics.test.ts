import { describe, expect, it } from "vitest";
import {
  artifactFetchErrorFields,
  emitArtifactDiagnostic,
  relayArtifactDiagnostics,
} from "../../bindings/artifacts/ArtifactsDiagnostics.ts";

const event = { operation: "session", stage: "forward", outcome: "failure", transport: "fetch" };
const capture = (run: () => void) => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => {
    lines.push(line);
  };
  try {
    run();
  } finally {
    console.log = log;
  }
  return lines.map((line) => JSON.parse(line.slice("[artifacts-rpc] ".length)));
};

describe("Artifacts forwarding fetch diagnostics", () => {
  it("classifies only finite own-data names and codes", () => {
    for (const [name, kind] of [
      ["Error", "error"],
      ["TypeError", "type-error"],
      ["AbortError", "abort"],
      ["TimeoutError", "timeout"],
    ])
      expect(artifactFetchErrorFields({ name })).toEqual({ fetchErrorKind: kind });
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "EPIPE",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ])
      expect(artifactFetchErrorFields({ code })).toEqual({
        fetchErrorKind: "unknown",
        fetchErrorCode: code,
      });
    for (const value of [
      undefined,
      null,
      42,
      "ECONNRESET",
      new TypeError("sensitive-canary"),
      Object.create({ name: "TypeError", code: "ECONNRESET" }),
      { name: "sensitive-canary", code: "sensitive-canary" },
      { code: 1 },
    ])
      expect(artifactFetchErrorFields(value)).toEqual({ fetchErrorKind: "unknown" });
  });

  it("retains the first known name and first allowlisted code across three cause links", () => {
    expect(
      artifactFetchErrorFields({
        name: "TypeError",
        code: "unlisted",
        cause: {
          name: "Error",
          code: "ECONNRESET",
          cause: { code: "EPIPE" },
        },
      }),
    ).toEqual({ fetchErrorKind: "type-error", fetchErrorCode: "ECONNRESET" });
    expect(
      artifactFetchErrorFields({
        cause: { cause: { cause: { name: "TimeoutError", code: "ETIMEDOUT" } } },
      }),
    ).toEqual({ fetchErrorKind: "timeout", fetchErrorCode: "ETIMEDOUT" });
    expect(
      artifactFetchErrorFields({ cause: { cause: { cause: { cause: { code: "EPIPE" } } } } }),
    ).toEqual({ fetchErrorKind: "unknown" });
  });

  it("does not invoke accessors or inspect unrelated sensitive fields", () => {
    let reads = 0;
    const trapped = {};
    for (const key of [
      "name",
      "code",
      "cause",
      "message",
      "stack",
      "url",
      "headers",
      "body",
      "token",
    ])
      Object.defineProperty(trapped, key, {
        get() {
          reads++;
          throw new Error("sensitive-canary");
        },
      });
    expect(artifactFetchErrorFields(trapped)).toEqual({ fetchErrorKind: "unknown" });
    expect(reads).toBe(0);
    const allowed = new Proxy(
      { name: "AbortError", code: "ECONNABORTED" },
      {
        get() {
          throw new Error("sensitive-canary");
        },
        ownKeys() {
          throw new Error("sensitive-canary");
        },
        getPrototypeOf() {
          throw new Error("sensitive-canary");
        },
      },
    );
    expect(artifactFetchErrorFields(allowed)).toEqual({
      fetchErrorKind: "abort",
      fetchErrorCode: "ECONNABORTED",
    });
  });

  it("tolerates descriptor traps and revoked proxies without losing earlier known data", () => {
    const trapped = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("sensitive-canary");
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [trapped, revoked.proxy]) {
      expect(artifactFetchErrorFields(value)).toEqual({ fetchErrorKind: "unknown" });
      expect(artifactFetchErrorFields({ name: "Error", code: "EPIPE", cause: value })).toEqual({
        fetchErrorKind: "error",
        fetchErrorCode: "EPIPE",
      });
    }
  });

  it("stops cycles and does not inspect a fourth cause link", () => {
    const cycle: { cause?: unknown; code?: string } = {};
    cycle.cause = cycle;
    expect(artifactFetchErrorFields(cycle)).toEqual({ fetchErrorKind: "unknown" });
    let reflections = 0;
    const repeated = new Proxy(cycle, {
      getOwnPropertyDescriptor(target, key) {
        reflections++;
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    cycle.cause = repeated;
    expect(artifactFetchErrorFields(repeated)).toEqual({ fetchErrorKind: "unknown" });
    expect(reflections).toBe(3);
    let excess = 0;
    const last = Object.defineProperty({}, "cause", {
      get() {
        excess++;
        throw new Error("sensitive-canary");
      },
    });
    expect(artifactFetchErrorFields({ cause: { cause: { cause: last } } })).toEqual({
      fetchErrorKind: "unknown",
    });
    expect(excess).toBe(0);
  });

  it("validates finite fields at both direct emission and envelope relay", () => {
    const finite = {
      ...event,
      fetchErrorKind: "type-error",
      fetchErrorCode: "ECONNRESET",
      requestAborted: false,
      sessionAgeMs: 0,
    };
    const logs = capture(() => {
      emitArtifactDiagnostic({
        ...finite,
        message: "sensitive-canary",
        stack: "sensitive-canary",
        token: "sensitive-canary",
      });
      expect(
        relayArtifactDiagnostics({ diagnostics: [{ ...finite, sessionAgeMs: 3_000_000 }] }),
      ).toBe(true);
    });
    expect(logs).toEqual([finite, { ...finite, sessionAgeMs: 3_000_000 }]);
    for (const sessionAgeMs of [-1, 3_000_001, 0.5, NaN, Infinity, "0"]) {
      expect(capture(() => emitArtifactDiagnostic({ ...event, sessionAgeMs }))).toEqual([event]);
    }
    expect(
      capture(() =>
        emitArtifactDiagnostic({
          ...event,
          fetchErrorKind: "TypeError",
          fetchErrorCode: "sensitive-canary",
          requestAborted: 1,
        }),
      ),
    ).toEqual([event]);
    expect(JSON.stringify(logs).includes("sensitive-canary")).toBe(false);
  });

  it("keeps sink failures observational", () => {
    const log = console.log;
    console.log = () => {
      throw new Error("sensitive-canary");
    };
    try {
      emitArtifactDiagnostic({ ...event, ...artifactFetchErrorFields({ code: "EPIPE" }) });
    } finally {
      console.log = log;
    }
  });
});
