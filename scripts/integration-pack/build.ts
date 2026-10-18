import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { run } from "./io.ts";
import type { WorkspacePackage } from "./types.ts";

const within = (directory: string, target: string): boolean => {
  const path = relative(directory, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

interface CompilerConfig {
  readonly compilerOptions?: {
    readonly outDir?: string;
    readonly rootDir?: string;
    readonly tsBuildInfoFile?: string;
    readonly composite?: boolean;
    readonly incremental?: boolean;
  };
  readonly references?: ReadonlyArray<{ readonly path: string }>;
}

/** Resolve native emit directories and incremental metadata, without compiling. */
export const packageBuildOutputs = async (
  workspace: WorkspacePackage,
): Promise<ReadonlyArray<string>> => {
  const directories = new Set<string>();
  const metadata = new Set<string>();
  const visited = new Set<string>();
  const visitConfig = async (config: string): Promise<void> => {
    if (visited.has(config) || !within(workspace.directory, config)) return;
    visited.add(config);
    const options = JSON.parse(
      await run(
        [resolve(import.meta.dir, "../../node_modules/.bin/tsc"), "--showConfig", "-p", config],
        { cwd: workspace.directory, quiet: true },
      ),
    ) as CompilerConfig;
    const directory = dirname(config);
    const compiler = options.compilerOptions ?? {};
    const output = compiler.outDir === undefined ? undefined : resolve(directory, compiler.outDir);
    if (output !== undefined) directories.add(output);
    if (compiler.tsBuildInfoFile !== undefined) {
      metadata.add(resolve(directory, compiler.tsBuildInfoFile));
    } else if (compiler.composite || compiler.incremental) {
      const configBase = join(directory, basename(config, ".json"));
      metadata.add(
        `${
          output === undefined
            ? configBase
            : compiler.rootDir === undefined
              ? join(output, basename(configBase))
              : resolve(output, relative(resolve(directory, compiler.rootDir), configBase))
        }.tsbuildinfo`,
      );
    }
    for (const reference of options.references ?? []) {
      const target = resolve(directory, reference.path);
      if (!within(workspace.directory, target)) continue;
      await visitConfig(target.endsWith(".json") ? target : join(target, "tsconfig.json"));
    }
  };
  const config = join(workspace.directory, "tsconfig.json");
  if (await exists(config)) await visitConfig(config);

  const bundlerConfig = join(workspace.directory, "tsdown.config.ts");
  if (await exists(bundlerConfig)) {
    const ts = await import("typescript-api/unstable/ast");
    const { createSyntaxProject } = await import("../typescript-source.ts");
    await using syntax = await createSyntaxProject([bundlerConfig]);
    const source = await syntax.project.program.getSourceFile(bundlerConfig);
    if (source === undefined) throw new Error(`Cannot read bundler configuration ${bundlerConfig}`);
    let bundlerOutputs = 0;
    const visit = (node: import("typescript-api/unstable/ast").Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === "outDir"
      ) {
        if (!ts.isStringLiteral(node.initializer)) {
          throw new Error(
            `${workspace.name} has a non-literal bundler outDir; refuse output cleanup`,
          );
        }
        directories.add(resolve(workspace.directory, node.initializer.text));
        bundlerOutputs++;
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
    if (bundlerOutputs === 0)
      throw new Error(`${workspace.name} declares no controlled build output`);
  }

  // A published output root owns all its old chunks, including directories a
  // renamed bundler entry no longer writes. Compiler-only caches stay exact.
  const publishedRoots = (workspace.manifest.files ?? [])
    .filter((path) => !/[*!?]/.test(path) && !path.startsWith("!"))
    .map((path) => resolve(workspace.directory, path));
  const outputs = new Set(
    [...directories].map(
      (output) => publishedRoots.find((root) => root === output || within(root, output)) ?? output,
    ),
  );
  for (const path of metadata) outputs.add(path);
  const targets = [...outputs]
    .filter((target) => ![...outputs].some((other) => other !== target && within(other, target)))
    .sort();
  if (targets.length === 0) {
    throw new Error(
      `${workspace.name} declares no controlled native build output; refuse an unclean build`,
    );
  }
  const tracked = (
    await run(["git", "ls-files", "-z"], {
      cwd: workspace.directory,
      quiet: true,
    })
  )
    .split("\0")
    .filter(Boolean);
  for (const target of targets) {
    const path = relative(workspace.directory, target);
    if (
      !within(workspace.directory, target) ||
      ["src", "bin", "scripts", "skills", "patches", "node_modules", ".git"].includes(
        path.split(sep)[0]!,
      )
    ) {
      throw new Error(`${workspace.name} has unsafe build output ${target}`);
    }
    if (tracked.some((file) => file === path || file.startsWith(`${path}/`))) {
      throw new Error(`${workspace.name} build output contains tracked files: ${target}`);
    }
    let parent = target;
    while (parent !== workspace.directory) {
      if ((await exists(parent)) && (await lstat(parent)).isSymbolicLink()) {
        throw new Error(`${workspace.name} build output crosses a symbolic link: ${parent}`);
      }
      parent = dirname(parent);
    }
  }
  return targets;
};

/** Quarantine old outputs until the replacement build and archive are verified. */
export const withCleanBuildOutputs = async <A>(
  workspace: WorkspacePackage,
  use: () => Promise<A>,
): Promise<A> => {
  const targets = await packageBuildOutputs(workspace);
  const backup = await mkdtemp(join(tmpdir(), "alchemy-integration-build-"));
  const moved = new Map<string, string>();
  let prepared = false;
  let result: A;
  try {
    for (const [index, target] of targets.entries()) {
      if (!(await exists(target))) continue;
      const saved = join(backup, `original-${index}`);
      await rename(target, saved);
      moved.set(target, saved);
    }
    prepared = true;
    result = await use();
  } catch (error) {
    for (const [index, target] of targets.entries()) {
      if (!prepared && !moved.has(target)) continue;
      if (await exists(target)) await rename(target, join(backup, `failed-${index}`));
      const saved = moved.get(target);
      if (saved !== undefined) {
        await mkdir(dirname(target), { recursive: true });
        await rename(saved, target);
      }
    }
    throw new Error(
      `Building ${workspace.name} failed; original outputs restored; replacement output retained at ${backup}`,
      { cause: error },
    );
  }
  await rm(backup, { recursive: true, force: true });
  return result;
};
