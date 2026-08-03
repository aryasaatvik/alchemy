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
  options?: { readonly runNpmInstall?: NpmInstallRunner },
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

  const installedFiles = yield* installResolvedPackages({
    resolved,
    architecture: config.architecture,
    target: "host",
    runNpmInstall: options?.runNpmInstall,
  });
  yield* writeLocalBundleFiles(bundleDir, installedFiles);
  // Rolldown emits ESM. npm's temporary install manifest has no module type,
  // so replace it with the runtime contract after its dependency closure has
  // been materialized.
  yield* fs.writeFileString(
    path.join(bundleDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  return config;
});
