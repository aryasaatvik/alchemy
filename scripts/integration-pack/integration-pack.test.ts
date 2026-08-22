import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { integrationClosure } from "./graph.ts";
import { pnpmPackCommand } from "./pack.ts";
import {
  findExistingUpload,
  parsePackResult,
  parseUploadResult,
} from "./checkpoint.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");

describe("integration package graph", () => {
  test("orders local dependencies before Alchemy and resolves catalog-local edges", async () => {
    const closure = await integrationClosure(repositoryRoot);
    const names = closure.map((workspace) => workspace.name);
    const position = (name: string): number => {
      const index = names.indexOf(name);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };

    expect(position("@distilled.cloud/core")).toBeLessThan(
      position("@distilled.cloud/aws"),
    );
    expect(position("@distilled.cloud/cloudflare")).toBeLessThan(
      position("@alchemy.run/cloudflare-runtime"),
    );
    expect(position("@alchemy.run/cloudflare-runtime")).toBeLessThan(
      position("alchemy"),
    );
  });

  test("ships every tree referenced by selected Distilled runtime exports", async () => {
    const closure = await integrationClosure(repositoryRoot);
    for (const name of [
      "@distilled.cloud/axiom",
      "@distilled.cloud/cloudflare",
      "@distilled.cloud/neon",
      "@distilled.cloud/planetscale",
    ]) {
      const workspace = closure.find((candidate) => candidate.name === name);
      expect(workspace?.manifest.files).toContain("lib");
      expect(workspace?.manifest.files).toContain("src");
    }
  });
});

describe("integration package packing", () => {
  test("disables lifecycle scripts with pnpm's explicit config option", () => {
    expect(pnpmPackCommand("/tmp/output")).toEqual([
      "pnpm",
      "--config.ignore-scripts=true",
      "--config.node-linker=hoisted",
      "pack",
      "--pack-destination",
      "/tmp/output",
    ]);
  });
});

describe("integration checkpoint", () => {
  const result = {
    artifact: "/tmp/alchemy-2.0.0-samva.abc123.fingerprint.tgz",
    sha256: "a".repeat(64),
    version: "2.0.0-samva.abc123.fingerprint",
  };

  test("parses the exact artifact identity reported by the packer", () => {
    expect(
      parsePackResult(
        `Created ${result.artifact}\nVersion ${result.version}\nSHA256 ${result.sha256}\nConsumer dependency: ignored`,
      ),
    ).toEqual(result);
  });

  test("rejects incomplete packer output", () => {
    expect(() => parsePackResult(`Created ${result.artifact}`)).toThrow(
      "did not report one artifact, version, and SHA-256 digest",
    );
  });

  test("reuses the newest upload with the same filename and digest", () => {
    expect(
      findExistingUpload(
        [
          {
            id: "older",
            filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
            contentHash: result.sha256,
            url: "https://scratchpad.example/older",
            createdAt: "2026-08-20T00:00:00.000Z",
          },
          {
            id: "different-content",
            filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
            contentHash: "b".repeat(64),
            url: "https://scratchpad.example/different",
            createdAt: "2026-08-22T00:00:00.000Z",
          },
          {
            id: "newer",
            filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
            contentHash: result.sha256,
            url: "https://scratchpad.example/newer",
            createdAt: "2026-08-21T00:00:00.000Z",
          },
        ],
        result,
      )?.url,
    ).toBe("https://scratchpad.example/newer");
  });

  test("validates Scratchpad's upload response envelope", () => {
    expect(
      parseUploadResult(
        JSON.stringify({
          target: { profile: "production" },
          uploads: [
            {
              filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
              sha256: result.sha256,
              url: "https://scratchpad.example/checkpoint",
            },
          ],
        }),
        result,
      ).url,
    ).toBe("https://scratchpad.example/checkpoint");
  });

  test("rejects a Scratchpad response for different content", () => {
    expect(() =>
      parseUploadResult(
        JSON.stringify({
          uploads: [
            {
              filename: "alchemy-2.0.0-samva.abc123.fingerprint.tgz",
              sha256: "b".repeat(64),
              url: "https://scratchpad.example/checkpoint",
            },
          ],
        }),
        result,
      ),
    ).toThrow("did not match the verified integration artifact");
  });
});
