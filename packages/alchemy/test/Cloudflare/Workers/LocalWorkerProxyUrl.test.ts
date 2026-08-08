import { resolveDevServerOptions } from "@/Cloudflare/Workers/LocalWorkerProvider.ts";
import { describe, expect, test } from "alchemy-test";

describe("local Worker proxy URL", () => {
  test("reuses the previous state port across sidecar restarts", () => {
    expect(
      resolveDevServerOptions(
        { mode: "worker", port: 1337 },
        undefined,
        "http://localhost:1341",
      ),
    ).toEqual({ mode: "worker", port: 1341 });
  });

  test("an explicitly configured port remains authoritative", () => {
    expect(
      resolveDevServerOptions(
        { mode: "worker", port: 1444 },
        1444,
        "http://localhost:1341",
      ),
    ).toEqual({ mode: "worker", port: 1444 });
  });

  test("ignores non-local state URLs", () => {
    expect(
      resolveDevServerOptions(
        { mode: "worker", port: 1337 },
        undefined,
        "https://example.com",
      ),
    ).toEqual({ mode: "worker", port: 1337 });
  });
});
