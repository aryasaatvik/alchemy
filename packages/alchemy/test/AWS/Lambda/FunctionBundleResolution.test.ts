import * as Bundle from "@/Bundle/Bundle";
import { resolveFunctionBundleConfig } from "@/AWS/Lambda/Function";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

layer(NodeServices.layer)("Lambda function bundle resolution", (it) => {
  it.effect("preserves import and require export-map context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-lambda-export-conditions-",
      });
      const dependency = path.join(root, "node_modules", "dual-dependency");
      const consumer = path.join(root, "node_modules", "commonjs-consumer");
      const entry = path.join(root, "entry.mjs");
      const output = path.join(root, "output.mjs");

      try {
        yield* fs.makeDirectory(dependency, { recursive: true });
        yield* fs.makeDirectory(consumer, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ type: "module" }),
        );
        yield* fs.writeFileString(
          path.join(dependency, "package.json"),
          JSON.stringify({
            name: "dual-dependency",
            exports: {
              ".": {
                import: "./import.mjs",
                require: "./require.cjs",
                default: "./require.cjs",
              },
            },
          }),
        );
        yield* fs.writeFileString(
          path.join(dependency, "import.mjs"),
          'export const selected = "import"; export default { selected };',
        );
        yield* fs.writeFileString(
          path.join(dependency, "require.cjs"),
          'module.exports = class RequiredBase { static selected = "require"; };',
        );
        yield* fs.writeFileString(
          path.join(consumer, "package.json"),
          JSON.stringify({ name: "commonjs-consumer", main: "./index.cjs" }),
        );
        yield* fs.writeFileString(
          path.join(consumer, "index.cjs"),
          'const Base = require("dual-dependency"); module.exports = class Child extends Base {};',
        );
        yield* fs.writeFileString(
          entry,
          'import Child from "commonjs-consumer"; import { selected } from "dual-dependency"; export default [Child.selected, selected];',
        );

        const config = yield* resolveFunctionBundleConfig({
          main: entry,
          isExternal: true,
        });
        const result = yield* Bundle.build(
          config.inputOptions,
          config.outputOptions,
        );
        const code = result.files.find(
          (file) =>
            file.path === "index.js" && typeof file.content === "string",
        )?.content;
        expect(typeof code).toBe("string");
        yield* fs.writeFileString(output, code as string);

        const bundled = (yield* Effect.promise(() => import(output))) as {
          default: [string, string];
        };
        expect(bundled.default).toEqual(["require", "import"]);
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }),
  );
});
