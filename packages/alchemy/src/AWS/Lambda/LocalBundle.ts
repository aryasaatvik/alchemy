import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  installResolvedPackages,
  resolveInstallTargets,
  type NpmInstallRunner,
} from "../../Bundle/InstalledPackages.ts";
import { resolveFunctionBundleConfig, type FunctionProps } from "./Function.ts";

interface LocalBundleFile {
  readonly path: string;
  readonly content: string | Uint8Array<ArrayBufferLike>;
}

interface InstalledPackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

const resolvedPackageIdentity = (
  packageName: string,
  installSpec: string,
): { readonly name: string; readonly version: string } | undefined => {
  if (!installSpec.startsWith("npm:")) {
    return { name: packageName, version: installSpec };
  }
  const descriptor = installSpec.slice("npm:".length);
  const versionSeparator = descriptor.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === descriptor.length - 1) {
    return undefined;
  }
  return {
    name: descriptor.slice(0, versionSeparator),
    version: descriptor.slice(versionSeparator + 1),
  };
};

/**
 * Locate one package-manager materialized dependency authority above the
 * Function source or an explicitly supplied evaluation root. Every requested
 * root must resolve inside that same `node_modules` tree at the exact
 * lock-resolved identity; workspace links and stale/range-only installs
 * deliberately fall back to the isolated install.
 */
const findReusableNodeModules = Effect.fn(function* (
  searchRoots: ReadonlyArray<string>,
  resolved: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packages = Object.entries(resolved).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (packages.length === 0) return undefined;

  const visited = new Set<string>();
  for (const searchRoot of searchRoots) {
    let directory = path.resolve(searchRoot);
    while (!visited.has(directory)) {
      visited.add(directory);
      const candidate = path.join(directory, "node_modules");
      const realCandidate = yield* fs
        .realPath(candidate)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (realCandidate !== undefined) {
        let matches = true;
        for (const [packageName, installSpec] of packages) {
          const expected = resolvedPackageIdentity(packageName, installSpec);
          const packageDirectory = path.join(candidate, packageName);
          const realPackageDirectory = yield* fs
            .realPath(packageDirectory)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (expected === undefined || realPackageDirectory === undefined) {
            matches = false;
            break;
          }

          const relativePackageDirectory = path.relative(
            realCandidate,
            realPackageDirectory,
          );
          if (
            relativePackageDirectory === "" ||
            relativePackageDirectory === ".." ||
            relativePackageDirectory.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativePackageDirectory)
          ) {
            matches = false;
            break;
          }

          const manifest = yield* fs
            .readFileString(path.join(realPackageDirectory, "package.json"))
            .pipe(
              Effect.flatMap((content) =>
                Effect.try(
                  () => JSON.parse(content) as InstalledPackageManifest,
                ),
              ),
              Effect.catch(() => Effect.succeed(undefined)),
            );
          if (
            manifest?.name !== expected.name ||
            manifest.version !== expected.version
          ) {
            matches = false;
            break;
          }
        }
        if (matches) return realCandidate;
      }

      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
});

/** Write bundle output or installed package files beneath a local bundle root. */
export const writeLocalBundleFiles = Effect.fn(function* (
  bundleDir: string,
  files: ReadonlyArray<LocalBundleFile>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const file of files) {
    const filePath = path.join(bundleDir, file.path);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    if (typeof file.content === "string") {
      yield* fs.writeFileString(filePath, file.content);
    } else {
      yield* fs.writeFile(filePath, file.content);
    }
  }
});

/**
 * Prepare the isolated directory retained by a local Lambda watcher.
 * Requested packages are installed once for the host and reused by every
 * subsequent bundle rebuild until the watcher scope closes.
 */
export const prepareLocalFunctionBundle = Effect.fn(function* (
  props: FunctionProps,
  bundleDir: string,
  options?: {
    readonly additionalDependencySearchRoots?: ReadonlyArray<string>;
    readonly runNpmInstall?: NpmInstallRunner;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* resolveFunctionBundleConfig(props, {
    externalizeAwsSdk: false,
    registerRuntimeExtension: false,
  });
  const resolved = yield* resolveInstallTargets({
    cwd: config.cwd,
    requested: config.requested,
  });

  if (yield* fs.exists(bundleDir)) {
    yield* fs.remove(bundleDir, { recursive: true });
  }
  yield* fs.makeDirectory(bundleDir, { recursive: true });
  yield* Effect.addFinalizer(() =>
    fs.remove(bundleDir, { recursive: true }).pipe(Effect.ignore),
  );

  const reusableNodeModules = yield* findReusableNodeModules(
    [config.cwd, ...(options?.additionalDependencySearchRoots ?? [])],
    resolved,
  );
  const dependencySource =
    Object.keys(resolved).length === 0
      ? ({ _tag: "None" } as const)
      : reusableNodeModules === undefined
        ? ({ _tag: "IsolatedInstall" } as const)
        : ({
            _tag: "Workspace",
            nodeModulesPath: reusableNodeModules,
          } as const);

  if (dependencySource._tag === "Workspace") {
    yield* fs.symlink(
      dependencySource.nodeModulesPath,
      path.join(bundleDir, "node_modules"),
    );
  } else if (dependencySource._tag === "IsolatedInstall") {
    const installedFiles = yield* installResolvedPackages({
      resolved,
      architecture: config.architecture,
      target: "host",
      runNpmInstall: options?.runNpmInstall,
    });
    yield* writeLocalBundleFiles(bundleDir, installedFiles);
  }
  // Rolldown emits ESM. npm's temporary install manifest has no module type,
  // so replace it with the runtime contract after its dependency closure has
  // been materialized.
  yield* fs.writeFileString(
    path.join(bundleDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  return { ...config, dependencySource };
});
