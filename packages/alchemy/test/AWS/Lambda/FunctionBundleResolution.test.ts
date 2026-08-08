import * as Bundle from "@/Bundle/Bundle";
import { resolveFunctionBundleConfig } from "@/AWS/Lambda/Function";
import {
  prepareLocalFunctionBundle,
  writeLocalBundleFiles,
} from "@/AWS/Lambda/LocalBundle";
import { exec } from "@/Util/exec";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

layer(NodeServices.layer)("Lambda function bundle resolution", (it) => {
  it.effect("externalizes workerd's virtual module", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-lambda-workerd-external-",
      });
      const entry = path.join(root, "handler.mjs");

      try {
        yield* fs.writeFileString(entry, "export const handler = () => null;");
        const config = yield* resolveFunctionBundleConfig({
          main: entry,
          isExternal: true,
        });
        const external = config.inputOptions.external;

        expect(typeof external).toBe("function");
        expect(
          (
            external as (
              moduleId: string,
              parentId: string | undefined,
              isResolved: boolean,
            ) => boolean
          )("cloudflare:workers", entry, false),
        ).toBe(true);
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }),
  );

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

  it.effect(
    "materializes build.install packages for isolated local children",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-local-lambda-install-",
        });
        const sourceDir = path.join(root, "source");
        const bundleDir = path.join(root, "isolated", "bundle");
        const main = path.join(sourceDir, "handler.mjs");
        let installs = 0;

        try {
          yield* fs.makeDirectory(sourceDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(sourceDir, "package.json"),
            JSON.stringify({
              type: "module",
              dependencies: { "fixture-native-data": "1.0.0" },
            }),
          );

          const writeHandler = (version: string) =>
            fs.writeFileString(
              main,
              `import fixture from "fixture-native-data"; console.log(JSON.stringify({ version: ${JSON.stringify(version)}, ...fixture }));`,
            );

          yield* writeHandler("v1");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const config = yield* prepareLocalFunctionBundle(
                {
                  main,
                  isExternal: true,
                  build: { install: ["fixture-native-data"] },
                },
                bundleDir,
                {
                  runNpmInstall: (directory, args) =>
                    Effect.gen(function* () {
                      installs += 1;
                      expect(args).toEqual(["install", "--force"]);
                      const packageDir = path.join(
                        directory,
                        "node_modules",
                        "fixture-native-data",
                      );
                      yield* fs.makeDirectory(path.join(packageDir, "data"), {
                        recursive: true,
                      });
                      yield* fs.makeDirectory(path.join(packageDir, "native"), {
                        recursive: true,
                      });
                      yield* fs.writeFileString(
                        path.join(packageDir, "package.json"),
                        JSON.stringify({
                          name: "fixture-native-data",
                          version: "1.0.0",
                          type: "module",
                          exports: "./index.js",
                        }),
                      );
                      yield* fs.writeFileString(
                        path.join(packageDir, "index.js"),
                        `import { readFileSync } from "node:fs";
export default {
  data: readFileSync(new URL("./data/payload.txt", import.meta.url), "utf8"),
  native: Array.from(readFileSync(new URL("./native/addon.node", import.meta.url))),
};`,
                      );
                      yield* fs.writeFileString(
                        path.join(packageDir, "data", "payload.txt"),
                        "materialized",
                      );
                      yield* fs.writeFile(
                        path.join(packageDir, "native", "addon.node"),
                        new Uint8Array([1, 3, 3, 7]),
                      );
                    }),
                },
              );

              for (const version of ["v1", "v2"]) {
                if (version === "v2") yield* writeHandler(version);
                const output = yield* Bundle.build(
                  config.inputOptions,
                  config.outputOptions,
                );
                yield* writeLocalBundleFiles(bundleDir, output.files);

                const command = ChildProcess.make(
                  process.execPath,
                  typeof globalThis.Bun === "undefined"
                    ? [path.join(bundleDir, "index.js")]
                    : ["run", path.join(bundleDir, "index.js")],
                  { shell: false },
                );
                const child = yield* exec(command).pipe(Effect.scoped);
                expect(child.exitCode).toBe(0);
                expect(child.stderr).toBe("");
                expect(JSON.parse(child.stdout.trim())).toEqual({
                  version,
                  data: "materialized",
                  native: [1, 3, 3, 7],
                });
              }
              expect(installs).toBe(1);
            }),
          );
          expect(yield* fs.exists(bundleDir)).toBe(false);
        } finally {
          yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        }
      }),
  );
});
