import childProcess from "node:child_process";
import { makeFunctionBundler } from "@alchemy.run/aws/Lambda/FunctionBundle";
import { bundleMicrovmProgram } from "@alchemy.run/aws/Lambda/MicrovmBundle";
import { makeDevWatchProvider } from "@alchemy.run/aws/Local/DevWatchProvider";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Artifacts from "alchemy/Artifacts";
import * as ProviderSessionConfig from "alchemy/Local/ProviderSessionConfig";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

interface TestFunction extends Resource<
  "Test.ImmutableFunction",
  { main: string },
  { hash: string }
> {}
const TestFunction = Resource<TestFunction>("Test.ImmutableFunction");
const stack = { name: "immutable", stage: "test", resources: {}, bindings: {}, actions: {} };

const localServices = (immutable: boolean | undefined) =>
  Layer.mergeAll(
    Layer.succeed(Stack, stack),
    Layer.succeed(Stage, "test"),
    Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy", dev: true, adopt: false }),
    Layer.sync(Artifacts.ArtifactStore, Artifacts.createArtifactStore),
    // A custom endpoint skips emulator startup; the test provider makes no requests.
    ProviderSessionConfig.layer("AWS", { local: { endpoint: "http://127.0.0.1:1" } }),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown(
        immutable === undefined ? {} : { ALCHEMY_DEV_IMMUTABLE: String(immutable) },
      ),
    ),
  );

layer(NodeServices.layer)("immutable Lambda compilation", (it) => {
  it.effect(
    "retains the first compiled artifact without opening a watcher or a second compiler",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-immutable-function-" });
        const main = `${root}/entry.ts`;
        yield* fs.writeFileString(main, 'export default "LAMBDA_IMMUTABLE";');
        let compilers = 0;
        let watches = 0;
        const originalFork = childProcess.fork;
        childProcess.fork = (...args: Parameters<typeof originalFork>) => {
          compilers++;
          return originalFork(...args);
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            childProcess.fork = originalFork;
          }),
        );
        const live = Provider.effect(
          TestFunction,
          Effect.gen(function* () {
            const bundler = yield* makeFunctionBundler;
            return {
              read: () => Effect.undefined,
              reconcile: ({ news }) =>
                Effect.gen(function* () {
                  const artifact = yield* bundler.bundleCode("handler", {
                    main: news.main,
                    isExternal: true,
                  });
                  const zip = yield* artifact.buildArchive;
                  expect(zip.archive.byteLength).toBeGreaterThan(0);
                  return { hash: artifact.identityHash };
                }),
              delete: () => Effect.void,
            };
          }),
        );
        const providerLayer = makeDevWatchProvider(TestFunction, "unused://provider", {
          liveProvider: () => live,
          watchConfigOf: (news) => news,
          startWatch: () =>
            Effect.sync(() => {
              watches++;
            }).pipe(Effect.andThen(Effect.never)),
        }).pipe(Layer.provide(localServices(true)));
        yield* Effect.gen(function* () {
          const provider = yield* TestFunction.Provider;
          const input = {
            id: "handler",
            fqn: "handler",
            instanceId: "one",
            news: { main },
            olds: undefined,
            output: undefined,
            bindings: [],
            session: noopSession,
          };
          const output = yield* provider.reconcile(input);
          expect(output.hash).toMatch(/^[a-f0-9]{64}$/);
          const diff = yield* provider.diff!({
            ...input,
            olds: input.news,
            output,
            oldBindings: [],
            newBindings: [],
          });
          expect(diff).toEqual({ action: "noop" });
          yield* Effect.yieldNow;
          expect(watches).toBe(0);
          expect(compilers).toBe(1);
        }).pipe(Effect.provide(providerLayer));
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );

  it.effect("starts the interactive watcher when the switch is absent", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const live = Provider.effect(
        TestFunction,
        Effect.succeed({
          read: () => Effect.undefined,
          reconcile: () => Effect.succeed({ hash: "initial" }),
          delete: () => Effect.void,
        }),
      );
      const providerLayer = makeDevWatchProvider(TestFunction, "unused://provider", {
        liveProvider: () => live,
        watchConfigOf: (news) => news,
        startWatch: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Layer.provide(localServices(undefined)));
      yield* Effect.gen(function* () {
        const provider = yield* TestFunction.Provider;
        const output = yield* provider.reconcile({
          id: "handler",
          fqn: "handler",
          instanceId: "one",
          news: { main: "unused.ts" },
          olds: undefined,
          output: undefined,
          bindings: [],
          session: noopSession,
        });
        yield* Deferred.await(started);
        expect(output.hash).toBe("initial");
      }).pipe(Effect.provide(providerLayer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "isolates generated WebFunction entries, MicroVM programs and prebuilt archives",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-function-variants-" });
        const main = `${root}/entry.ts`;
        yield* fs.writeFileString(main, 'export default "FUNCTION_VARIANT";');
        const bundler = yield* makeFunctionBundler;
        const generated = yield* bundler.bundleCode(
          "web",
          { main },
          { entry: (entry) => `export { default } from ${JSON.stringify(entry)};` },
        );
        expect((yield* generated.buildArchive).archive.byteLength).toBeGreaterThan(0);
        const prebuilt = yield* bundler.bundleCode("prebuilt", { main, bundle: false });
        expect((yield* prebuilt.buildArchive).archive.byteLength).toBeGreaterThan(0);
        const microvm = yield* bundleMicrovmProgram({
          main,
          runtime: "node",
          port: 8080,
          isExternal: true,
        });
        expect(microvm.files[0].path).toBe("index.mjs");
        expect(new TextDecoder().decode(microvm.files[0].content)).toContain("FUNCTION_VARIANT");
        const callback = yield* Effect.result(
          bundler.bundleCode("invalid", {
            main,
            isExternal: true,
            build: { external: () => false },
          }),
        );
        expect(Result.isFailure(callback)).toBe(true);
        if (Result.isFailure(callback))
          expect(callback.failure.message).toContain("callbacks are unsupported");
      }).pipe(Effect.provide(localServices(true)), Effect.scoped),
    { timeout: 60_000 },
  );
});
