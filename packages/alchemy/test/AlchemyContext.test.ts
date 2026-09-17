import { makeAlchemyContext } from "@/AlchemyContext.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

describe("AlchemyContext data root", () => {
  it.effect(
    "resolves an explicit relative data directory from the process cwd",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-context-",
        });
        const relative = path.relative(
          process.cwd(),
          path.join(parent, "state"),
        );
        const context = yield* makeAlchemyContext({ dataDir: relative });

        expect(context.dotAlchemy).toBe(path.resolve(process.cwd(), relative));
        expect(yield* fs.exists(context.dotAlchemy)).toBe(true);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("preserves an explicit absolute data directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-context-",
      });
      const absolute = path.join(parent, "state");
      const context = yield* makeAlchemyContext({ dataDir: absolute });

      expect(context.dotAlchemy).toBe(absolute);
      expect(yield* fs.exists(absolute)).toBe(true);
    }).pipe(Effect.provide(PlatformServices)),
  );
});
