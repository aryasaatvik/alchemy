import * as Bundle from "@/Bundle/Bundle";
import {
  makeFunctionProvider,
  resolveFunctionBundleConfig,
  type FunctionCodeBundle,
  type FunctionProps,
} from "@/AWS/Lambda/Function";
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
  it.effect(
    "invalidates an Effectful Function when a transitive source changes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* Effect.context<
          FileSystem.FileSystem | Path.Path
        >();
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-lambda-transitive-source-",
        });
        const entry = path.join(root, "handler.mjs");
        const dependency = path.join(root, "dependency.mjs");

        const writeDependency = (generation: string) =>
          fs.writeFileString(
            dependency,
            `export const generation = ${JSON.stringify(generation)};`,
          );

        try {
          yield* fs.writeFileString(
            path.join(root, "package.json"),
            JSON.stringify({ type: "module" }),
          );
          yield* fs.writeFileString(
            entry,
            'import { generation } from "./dependency.mjs"; export const handler = () => generation;',
          );
          yield* writeDependency("generation-one");

          const props = {
            main: entry,
            isExternal: true,
          } satisfies FunctionProps;
          const bundleCode = Effect.fn(function* (
            _id: string,
            news: FunctionProps,
          ): Effect.fn.Return<FunctionCodeBundle, Bundle.BundleError> {
            const config = yield* resolveFunctionBundleConfig(news).pipe(
              Effect.provide(platform),
              Effect.mapError((cause) =>
                cause instanceof Bundle.BundleError
                  ? cause
                  : new Bundle.BundleError({
                      message: "Failed to resolve the fixture bundle",
                      cause,
                    }),
              ),
            );
            const bundle = yield* Bundle.build(
              config.inputOptions,
              config.outputOptions,
              config.extra,
            );
            return {
              identityHash: bundle.hash,
              buildArchive: Effect.succeed({
                archive: new Uint8Array(),
                archiveHash: bundle.hash,
              }),
            };
          });
          const provider = yield* makeFunctionProvider({ bundleCode });
          const initial = yield* bundleCode("Function", props);
          const attrs = (hash: string) => ({
            functionArn: "arn:aws:lambda:us-east-1:123:function:test",
            functionName: "test",
            functionUrl: undefined,
            roleName: "test-role",
            roleArn: "arn:aws:iam::123:role/test-role",
            code: { hash },
          });
          const desired = {
            ...props,
            // Platform() adds this runtime-only Effect to every Effectful
            // Function declaration. Persisted props intentionally omit it.
            exports: Effect.succeed(["handler"]),
          };
          const diff = (hash: string) =>
            provider.diff!({
              id: "Function",
              fqn: "Function",
              instanceId: "instance",
              olds: props,
              news: desired,
              output: attrs(hash),
              oldBindings: [],
              newBindings: [],
            });

          expect(yield* diff(initial.identityHash)).toEqual({ action: "noop" });

          yield* writeDependency("generation-two");
          expect(yield* diff(initial.identityHash)).toEqual({
            action: "update",
          });

          // Model Apply persisting the terminal bundle identity: the next
          // unchanged plan must return to noop instead of remaining dirty.
          const updated = yield* bundleCode("Function", props);
          expect(updated.identityHash).not.toBe(initial.identityHash);
          expect(yield* diff(updated.identityHash)).toEqual({ action: "noop" });
        } finally {
          yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        }
      }),
  );

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
    "reuses one verified workspace dependency authority across local bundles",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-local-lambda-workspace-",
        });
        const workspace = path.join(root, "evaluation-workspace");
        const sourceDir = path.join(root, "function-source", "src");
        const nodeModules = path.join(workspace, "node_modules");
        const dependency = path.join(nodeModules, "fixture-dependency");
        const bundleDirs = [
          path.join(root, "instances", "first", "bundle"),
          path.join(root, "instances", "second", "bundle"),
        ];
        const main = path.join(sourceDir, "handler.mjs");
        let installs = 0;

        try {
          yield* fs.makeDirectory(sourceDir, { recursive: true });
          yield* fs.makeDirectory(dependency, { recursive: true });
          yield* fs.writeFileString(
            path.join(workspace, "package.json"),
            JSON.stringify({
              dependencies: { "fixture-dependency": "1.0.0" },
            }),
          );
          yield* fs.writeFileString(
            path.join(dependency, "package.json"),
            JSON.stringify({
              name: "fixture-dependency",
              version: "1.0.0",
            }),
          );
          yield* fs.writeFileString(
            path.join(dependency, "index.js"),
            'module.exports = "workspace";',
          );
          yield* fs.writeFileString(
            main,
            'import fixture from "fixture-dependency"; export default fixture;',
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              for (const [index, bundleDir] of bundleDirs.entries()) {
                const config = yield* prepareLocalFunctionBundle(
                  {
                    main,
                    isExternal: true,
                    build: {
                      install: { "fixture-dependency": "1.0.0" },
                    },
                  },
                  bundleDir,
                  {
                    additionalDependencySearchRoots: [workspace],
                    runNpmInstall: () =>
                      Effect.sync(() => {
                        installs += 1;
                      }),
                  },
                );
                expect(config.dependencySource).toEqual({
                  _tag: "Workspace",
                  nodeModulesPath: yield* fs.realPath(nodeModules),
                });
                expect(
                  yield* fs.readLink(path.join(bundleDir, "node_modules")),
                ).toBe(yield* fs.realPath(nodeModules));
                yield* writeLocalBundleFiles(bundleDir, [
                  {
                    path: "index.js",
                    content: `export default ${index};`,
                  },
                ]);
              }

              expect(installs).toBe(0);
              expect(
                yield* fs.readFileString(path.join(bundleDirs[0]!, "index.js")),
              ).toBe("export default 0;");
              expect(
                yield* fs.readFileString(path.join(bundleDirs[1]!, "index.js")),
              ).toBe("export default 1;");
            }),
          );

          for (const bundleDir of bundleDirs) {
            expect(yield* fs.exists(bundleDir)).toBe(false);
          }
          expect(yield* fs.exists(dependency)).toBe(true);
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
          const staleDependency = path.join(
            sourceDir,
            "node_modules",
            "fixture-native-data",
          );
          yield* fs.makeDirectory(staleDependency, { recursive: true });
          yield* fs.writeFileString(
            path.join(staleDependency, "package.json"),
            JSON.stringify({
              name: "fixture-native-data",
              version: "2.0.0",
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
              expect(config.dependencySource).toEqual({
                _tag: "IsolatedInstall",
              });

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
