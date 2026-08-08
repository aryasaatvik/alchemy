import { sha256 } from "@/Util/sha256";
import { zipCode } from "@/Util/zip";
import * as Effect from "effect/Effect";
import { expect, test } from "alchemy-test";

test("zipCode is deterministic for identical inputs", async () => {
  const hash = () =>
    Effect.runPromise(
      zipCode("export default 1", [
        {
          path: "index.mjs.map",
          content: JSON.stringify({
            version: 3,
            sources: ["index.ts"],
          }),
        },
      ]).pipe(Effect.flatMap(sha256)),
    );

  const first = await hash();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await hash()).toBe(first);
});

// Nested paths make JSZip synthesize intermediate folder entries; those must
// carry the fixed archive date or the bytes differ across builds.
test("zipCode is deterministic for nested package paths", async () => {
  const build = () =>
    Effect.runPromise(
      zipCode("export default 1", [
        {
          path: "node_modules/uuid/package.json",
          content: JSON.stringify({ name: "uuid" }),
        },
      ]),
    );

  const first = await build();
  const zip = await (await import("jszip")).default.loadAsync(first);
  for (const entry of Object.values(zip.files)) {
    expect(entry.date.toISOString()).toBe("1980-01-01T00:00:00.000Z");
  }

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await build();
  expect(await Effect.runPromise(sha256(second))).toBe(
    await Effect.runPromise(sha256(first)),
  );
});

test("zipCode STORE is deterministic and round-trips every entry", async () => {
  const build = () =>
    Effect.runPromise(
      zipCode(
        "export default 1",
        [
          {
            path: "fixtures/data.txt",
            content: "local emulator fixture\n".repeat(100),
          },
        ],
        "STORE",
      ),
    );

  const first = await build();
  const second = await build();
  expect(await Effect.runPromise(sha256(second))).toBe(
    await Effect.runPromise(sha256(first)),
  );

  const JSZip = (await import("jszip")).default;
  const archive = await JSZip.loadAsync(first);
  expect(await archive.file("index.mjs")?.async("string")).toBe(
    "export default 1",
  );
  expect(await archive.file("fixtures/data.txt")?.async("string")).toBe(
    "local emulator fixture\n".repeat(100),
  );
});

test("zipCode keeps DEFLATE as the smaller default", async () => {
  const files = [{ path: "data.txt", content: "compressible\n".repeat(1_000) }];
  const compressed = await Effect.runPromise(zipCode("entry", files));
  const stored = await Effect.runPromise(zipCode("entry", files, "STORE"));
  expect(compressed.byteLength).toBeLessThan(stored.byteLength);
});

test("zipCode NATIVE_FAST is deterministic, compressed, and readable", async () => {
  const files = [
    {
      path: "fixtures/source-map.json",
      content: JSON.stringify({
        version: 3,
        sources: ["src/api.ts"],
        mappings: "AAAA,SAASA,GAAG,CAACC,IAAI,EAAG;".repeat(1_000),
      }),
    },
  ];
  const [first, second, stored] = await Promise.all([
    Effect.runPromise(zipCode("export default 1", files, "NATIVE_FAST")),
    Effect.runPromise(zipCode("export default 1", files, "NATIVE_FAST")),
    Effect.runPromise(zipCode("export default 1", files, "STORE")),
  ]);
  expect(await Effect.runPromise(sha256(second))).toBe(
    await Effect.runPromise(sha256(first)),
  );
  expect(first.byteLength).toBeLessThan(stored.byteLength);

  const JSZip = (await import("jszip")).default;
  const archive = await JSZip.loadAsync(first);
  expect(await archive.file("index.mjs")?.async("string")).toBe(
    "export default 1",
  );
  expect(await archive.file("fixtures/source-map.json")?.async("string")).toBe(
    files[0]!.content,
  );
});

test("zipCode NATIVE_FAST accepts non-Buffer Uint8Array inputs", async () => {
  const encoder = new TextEncoder();
  const content = encoder.encode("export default 1");
  const fixture = encoder.encode("local emulator fixture\n");
  expect(Buffer.isBuffer(content)).toBe(false);
  expect(Buffer.isBuffer(fixture)).toBe(false);

  const build = () =>
    Effect.runPromise(
      zipCode(
        content,
        [{ path: "fixtures/data.txt", content: fixture }],
        "NATIVE_FAST",
      ),
    );
  const first = await build();
  const second = await build();
  expect(await Effect.runPromise(sha256(second))).toBe(
    await Effect.runPromise(sha256(first)),
  );

  const JSZip = (await import("jszip")).default;
  const archive = await JSZip.loadAsync(first);
  expect(await archive.file("index.mjs")?.async("uint8array")).toEqual(content);
  expect(await archive.file("fixtures/data.txt")?.async("uint8array")).toEqual(
    fixture,
  );
});
