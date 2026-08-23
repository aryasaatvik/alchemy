import { installResolvedPackagesFromLocalCache } from "@/Bundle/InstalledPackages";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { spawnSync } from "node:child_process";

const withWorkspace = <A, E, R>(
  use: (context: {
    readonly root: string;
    readonly cwd: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({
      prefix: "alchemy-local-package-cache-",
    });
    const cwd = path.join(root, "apps", "api");
    try {
      yield* fs.makeDirectory(cwd, { recursive: true });
      yield* fs.makeDirectory(path.join(root, "node_modules"));
      yield* fs.writeFileString(path.join(root, "package-lock.json"), "{}\n");
      yield* fs.writeFileString(path.join(cwd, "package.json"), "{}\n");
      return yield* use({ root, cwd, fs, path });
    } finally {
      yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
    }
  });

const identity = (lockHash = "lock-a") => ({
  resolved: { example: "1.2.3" },
  overrides: {},
  lockfile: { name: "package-lock.json", hash: lockHash },
});

const installFixture =
  (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    onInstall: (args: ReadonlyArray<string>) => Effect.Effect<void> = () =>
      Effect.void,
  ) =>
  (directory: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* onInstall(args);
      const packageRoot = path.join(directory, "node_modules", "example");
      yield* fs.makeDirectory(packageRoot, { recursive: true });
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "example", version: "1.2.3" }),
      );
      yield* fs.writeFileString(path.join(packageRoot, "index.js"), "ok\n");
      yield* fs.writeFileString(
        path.join(directory, "package-lock.json"),
        "{}\n",
      );
    });

describe("local Lambda package cache", () => {
  it.effect("fills once and returns the verified cached bytes on a hit", () =>
    withWorkspace(({ cwd, fs, path }) =>
      Effect.gen(function* () {
        let installs = 0;
        let observedArgs: ReadonlyArray<string> = [];
        const runNpmInstall = installFixture(fs, path, (args) =>
          Effect.sync(() => {
            installs++;
            observedArgs = args;
          }),
        );
        const options = {
          cwd,
          identity: identity(),
          architecture: "arm64" as const,
          npmIdentity: "npm@11.0.0",
          runNpmInstall,
        };

        const first = yield* installResolvedPackagesFromLocalCache(options);
        const second = yield* installResolvedPackagesFromLocalCache(options);

        expect(installs).toBe(1);
        expect(second).toEqual(first);
        expect(observedArgs).toEqual(
          expect.arrayContaining([
            "--prefer-offline",
            "--no-audit",
            "--no-fund",
          ]),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  // Live clock: the lock's spin backoff and the install latency are real-time.
  it.live("serializes concurrent misses for the same cache key", () =>
    withWorkspace(({ cwd, fs, path }) =>
      Effect.gen(function* () {
        let installs = 0;
        const runNpmInstall = installFixture(fs, path, () =>
          Effect.sync(() => installs++).pipe(Effect.andThen(Effect.sleep(100))),
        );
        const options = {
          cwd,
          identity: identity(),
          architecture: "arm64" as const,
          npmIdentity: "npm@11.0.0",
          runNpmInstall,
        };

        const results = yield* Effect.all(
          [
            installResolvedPackagesFromLocalCache(options),
            installResolvedPackagesFromLocalCache(options),
          ],
          { concurrency: "unbounded" },
        );

        expect(installs).toBe(1);
        expect(results[1]).toEqual(results[0]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("installs in atomic staging and cleans a failed fill", () =>
    withWorkspace(({ root, cwd, fs, path }) =>
      Effect.gen(function* () {
        let installDirectory = "";
        const error = yield* installResolvedPackagesFromLocalCache({
          cwd,
          identity: identity(),
          architecture: "arm64",
          npmIdentity: "npm@11.0.0",
          runNpmInstall: (directory) =>
            Effect.sync(() => {
              installDirectory = directory;
            }).pipe(Effect.andThen(Effect.fail("expected install failure"))),
        }).pipe(Effect.flip);
        const cacheRoot = path.join(
          root,
          "node_modules",
          ".cache",
          "alchemy",
          "lambda-packages",
        );

        expect(error.message).toContain("expected install failure");
        expect(installDirectory).toContain(cacheRoot);
        expect(installDirectory).toMatch(/\.tmp-[^/]+\/artifact$/);
        expect(yield* fs.readDirectory(cacheRoot)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rebuilds incomplete and corrupt entries", () =>
    withWorkspace(({ root, cwd, fs, path }) =>
      Effect.gen(function* () {
        let installs = 0;
        const options = {
          cwd,
          identity: identity(),
          architecture: "arm64" as const,
          npmIdentity: "npm@11.0.0",
          runNpmInstall: installFixture(fs, path, () =>
            Effect.sync(() => installs++),
          ),
        };
        yield* installResolvedPackagesFromLocalCache(options);
        const cacheRoot = path.join(
          root,
          "node_modules",
          ".cache",
          "alchemy",
          "lambda-packages",
        );
        const entries = (yield* fs.readDirectory(cacheRoot)).filter(
          (name) => !name.endsWith(".lock"),
        );
        expect(entries).toHaveLength(1);
        const entry = path.join(cacheRoot, entries[0]!);
        yield* fs.writeFileString(path.join(entry, "complete.json"), "{}");
        yield* installResolvedPackagesFromLocalCache(options);
        yield* fs.writeFileString(
          path.join(entry, "artifact", "node_modules", "example", "index.js"),
          "corrupt\n",
        );
        yield* installResolvedPackagesFromLocalCache(options);
        expect(installs).toBe(3);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("invalidates on lockfile, architecture, and npm identity", () =>
    withWorkspace(({ cwd, fs, path }) =>
      Effect.gen(function* () {
        let installs = 0;
        const runNpmInstall = installFixture(fs, path, () =>
          Effect.sync(() => installs++),
        );
        const base = {
          cwd,
          identity: identity(),
          architecture: "arm64" as const,
          npmIdentity: "npm@11.0.0",
          runNpmInstall,
        };
        yield* installResolvedPackagesFromLocalCache(base);
        yield* installResolvedPackagesFromLocalCache({
          ...base,
          identity: identity("lock-b"),
        });
        yield* installResolvedPackagesFromLocalCache({
          ...base,
          architecture: "x86_64",
        });
        yield* installResolvedPackagesFromLocalCache({
          ...base,
          npmIdentity: "npm@11.1.0",
        });
        expect(installs).toBe(4);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("does not add process exit hooks to the Function provider graph", () => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        [
          "const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];",
          "await import('./src/Bundle/InstalledPackages.ts');",
          "const afterCache = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];",
          "await import('./src/AWS/Lambda/FunctionProvider.ts');",
          "const afterProvider = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];",
          "console.log(JSON.stringify({ before, afterCache, afterProvider }));",
        ].join(" "),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      before: [0, 0],
      afterCache: [0, 0],
      // The Function provider graph no longer installs shutdown handlers at
      // import time; the package cache must preserve that lifecycle boundary.
      afterProvider: [0, 0],
    });
  });
});
