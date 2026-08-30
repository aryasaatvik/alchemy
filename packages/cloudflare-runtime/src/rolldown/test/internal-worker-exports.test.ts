import type { OutputBundle, OutputChunk, RolldownOutput } from "rolldown";
import { rolldown } from "rolldown";
import { assert, describe, expect, it } from "vitest";
import { InternalWorkerExportPlugin } from "../../internal/build-tools/InternalWorkerExportPlugin.ts";

const makeBundle = (reverseInsertionOrder: boolean): OutputBundle => {
  const chunks = [
    {
      type: "chunk",
      fileName: "entry.mjs",
      isEntry: true,
      imports: ["z.mjs", "a.mjs"],
      code: "entry();",
    },
    {
      type: "chunk",
      fileName: "z.mjs",
      isEntry: false,
      imports: [],
      code: "z();",
    },
    {
      type: "chunk",
      fileName: "a.mjs",
      isEntry: false,
      imports: [],
      code: "a();",
    },
  ];
  const ordered = reverseInsertionOrder ? chunks.toReversed() : chunks;
  return Object.fromEntries(
    ordered.map((chunk) => [chunk.fileName, chunk]),
  ) as unknown as OutputBundle;
};

const renderBundle = (
  bundle: OutputBundle,
): Readonly<Record<string, string>> => {
  const plugin = InternalWorkerExportPlugin();
  const generateBundle = plugin.generateBundle;
  assert(
    typeof generateBundle === "function",
    "generateBundle hook is not a function",
  );
  generateBundle.call({} as never, {}, bundle);
  return Object.fromEntries(
    Object.entries(bundle).map(([fileName, output]) => [
      fileName,
      output.type === "chunk" ? output.code : "",
    ]),
  );
};

describe("InternalWorkerExportPlugin", () => {
  it("renders stable worker exports when chunk order varies", () => {
    const first = renderBundle(makeBundle(false));
    const second = renderBundle(makeBundle(true));

    expect(second).toEqual(first);
    expect(first["entry.mjs"]).toContain('import worker0 from "./a.mjs";');
    expect(first["entry.mjs"]).toContain('import worker1 from "./z.mjs";');
  });

  it("repeats generated worker chunks byte-for-byte with execution ordering", async () => {
    const fixture = new URL(
      "./fixtures/internal-worker-repeat/index.ts",
      import.meta.url,
    ).pathname;
    const secondFixture = new URL(
      "./fixtures/internal-worker-repeat/second.ts",
      import.meta.url,
    ).pathname;
    const build = async (): Promise<RolldownOutput> => {
      const bundle = await rolldown({
        input: {
          first: fixture,
          second: secondFixture,
        },
        experimental: {
          chunkModulesOrder: "exec-order",
        },
        plugins: [InternalWorkerExportPlugin()],
      });
      try {
        return await bundle.generate({
          dir: "out/internal-worker-repeat",
          format: "esm",
          preserveModules: true,
        });
      } finally {
        await bundle.close();
      }
    };

    const snapshot = (output: RolldownOutput) =>
      output.output.map((item) => ({
        fileName: item.fileName,
        code: item.type === "chunk" ? item.code : item.source,
      }));

    const first = await build();
    const second = await build();

    expect(snapshot(second)).toEqual(snapshot(first));
    const firstEntry = first.output.find(
      (item): item is OutputChunk =>
        item.type === "chunk" && item.fileName === "first.js",
    );
    const secondEntry = first.output.find(
      (item): item is OutputChunk =>
        item.type === "chunk" && item.fileName === "second.js",
    );
    expect(firstEntry?.code).toContain(
      'import worker0 from "./alphabetically-first.js";\nimport worker1 from "./alphabetically-last.js";',
    );
    expect(secondEntry?.code).toContain(
      'import worker0 from "./alphabetically-first.js";\nimport worker1 from "./alphabetically-last.js";',
    );
    expect(firstEntry?.code).toContain(
      '"first.js": "import { alphabeticallyFirst } from \\\"./alphabetically-first.js\\\";\\nimport { alphabeticallyLast } from \\\"./alphabetically-last.js\\\";',
    );
    expect(secondEntry?.code).toContain(
      '"second.js": "import { alphabeticallyFirst } from \\\"./alphabetically-first.js\\\";\\nimport { alphabeticallyLast } from \\\"./alphabetically-last.js\\\";',
    );
  });
});
