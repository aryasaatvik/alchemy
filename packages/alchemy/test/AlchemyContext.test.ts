import { AlchemyContext, makeAlchemyContext } from "@/AlchemyContext.ts";
import { getStableContextDir } from "@/Bundle/TempRoot.ts";
import { ExecStackOptions } from "@/Cli/commands/deploy.ts";
import { localStorageDirectory } from "@/Cloudflare/LocalRuntime.ts";
import { watchPythonWorkerBundle } from "@/Cloudflare/Workers/Sources/Python.ts";
import { Stack } from "@/Stack.ts";
import { makeLocalState } from "@/State/LocalState.ts";
import { Stage } from "@/Stage.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

describe("AlchemyContext data root", () => {
  it.effect("defaults to <cwd>/.alchemy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* Effect.sync(() => process.cwd());
      const context = yield* makeAlchemyContext();

      expect(context.dotAlchemy).toBe(path.resolve(cwd, ".alchemy"));
      expect(yield* fs.exists(context.dotAlchemy)).toBe(true);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("resolves relative and absolute roots from the invoking cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* Effect.sync(() => process.cwd());
      const temp = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-data-root-",
      });
      const absolute = path.join(temp, "absolute");
      const relativeTarget = path.join(temp, "relative");
      const relative = path.relative(cwd, relativeTarget);

      const absoluteContext = yield* makeAlchemyContext({
        dataDir: absolute,
      });
      const relativeContext = yield* makeAlchemyContext({
        dataDir: relative,
      });

      expect(absoluteContext.dotAlchemy).toBe(absolute);
      expect(relativeContext.dotAlchemy).toBe(relativeTarget);
      expect(yield* fs.exists(absolute)).toBe(true);
      expect(yield* fs.exists(relativeTarget)).toBe(true);
    }).pipe(Effect.provide(PlatformServices), Effect.scoped),
  );

  it.effect("isolates local state across distinct roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-data-root-isolation-",
      });
      const contextA = yield* makeAlchemyContext({
        dataDir: path.join(temp, "a"),
      });
      const contextB = yield* makeAlchemyContext({
        dataDir: path.join(temp, "b"),
      });
      const stateA = yield* makeLocalState().pipe(
        Effect.provideService(AlchemyContext, contextA),
      );
      const stateB = yield* makeLocalState().pipe(
        Effect.provideService(AlchemyContext, contextB),
      );
      const key = { stack: "same-stack", stage: "same-stage" };

      yield* stateA.setOutput({ ...key, value: { root: "a" } });
      yield* stateB.setOutput({ ...key, value: { root: "b" } });

      expect(yield* stateA.getOutput(key)).toEqual({ root: "a" });
      expect(yield* stateB.getOutput(key)).toEqual({ root: "b" });
    }).pipe(Effect.provide(PlatformServices), Effect.scoped),
  );

  it.effect("roots temp and local-provider storage under the context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-operational-root-",
      });
      const context = yield* makeAlchemyContext({
        dataDir: path.join(temp, "instance"),
      });
      const stack = Stack.of({
        name: "root-test",
        stage: "dev",
        resources: {},
        bindings: {},
        actions: {},
      });

      const stableContext = yield* getStableContextDir(
        context.dotAlchemy,
        "worker",
      ).pipe(
        Effect.provideService(Stack, stack),
        Effect.provideService(Stage, "dev"),
      );
      const localStorage = yield* localStorageDirectory.pipe(
        Effect.provideService(AlchemyContext, context),
      );

      expect(stableContext).toBe(
        path.join(context.dotAlchemy, "tmp", "root-test-dev-worker"),
      );
      expect(localStorage).toBe(path.join(context.dotAlchemy, "local"));
    }).pipe(Effect.provide(PlatformServices), Effect.scoped),
  );

  it.effect("provides the root to Python worker watch builds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-python-worker-root-",
      });
      const main = path.join(temp, "worker.py");
      const context = yield* makeAlchemyContext({
        dataDir: path.join(temp, "root"),
      });
      yield* fs.writeFileString(main, "from workers import WorkerEntrypoint\n");

      const event = yield* watchPythonWorkerBundle({
        id: "python-root-test",
        main,
        compatibility: { date: "2026-08-07", flags: [] },
      }).pipe(
        Stream.provideService(AlchemyContext, context),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );

      expect(event._tag).toBe("Success");
      expect(yield* fs.exists(context.dotAlchemy)).toBe(true);
    }).pipe(Effect.provide(PlatformServices), Effect.scoped),
  );

  it.effect("roundtrips the root through watched exec options", () =>
    Effect.gen(function* () {
      const input: ExecStackOptions = {
        main: "alchemy.run.ts",
        stage: "dev",
        envFile: Option.none(),
        dataDir: Option.some(".runtime/e2e-a"),
        dev: true,
        yes: true,
      };

      const encoded = yield* Schema.encodeEffect(ExecStackOptions)(input);
      const decoded = yield* Schema.decodeUnknownEffect(ExecStackOptions)(
        JSON.parse(JSON.stringify(encoded)),
      );

      expect(encoded.dataDir).toBe(".runtime/e2e-a");
      expect(Option.getOrUndefined(decoded.dataDir)).toBe(".runtime/e2e-a");
    }),
  );
});
