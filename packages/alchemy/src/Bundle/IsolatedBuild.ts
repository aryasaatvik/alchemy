import childProcess from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as rolldown from "rolldown";
import { initialCwd, moduleExtension, nodeLoaderArgs } from "../Util/Node.ts";
import { bundleErrorFromUnknown, type BundleExtraOptions, type BundleOutput } from "./Bundle.ts";

/** Source must stay frozen until the dev session exits. */
export const immutableRun = Config.Boolean("ALCHEMY_DEV_IMMUTABLE").pipe(Config.withDefault(false));

const virtualEntries = new WeakMap<object, (importPath: string) => string>();

/** Keep executable plugin closures out of the compiler wire protocol. */
export const registerVirtualEntry = (
  plugin: rolldown.Plugin,
  content: (importPath: string) => string,
): void => {
  virtualEntries.set(plugin, content);
};

export interface IsolatedBuildRequest {
  readonly inputOptions: Omit<rolldown.InputOptions, "plugins">;
  readonly outputOptions: rolldown.OutputOptions;
  readonly extra: BundleExtraOptions | undefined;
  readonly entries: ReadonlyArray<Record<string, string>>;
}

export const IsolatedBuildResponse = Schema.Union([
  Schema.TaggedStruct("Success", {
    output: Schema.Struct({
      hash: Schema.String,
      files: Schema.NonEmptyArray(
        Schema.Struct({
          path: Schema.String,
          content: Schema.Union([Schema.String, Schema.Uint8Array]),
          hash: Schema.String,
          type: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
  Schema.TaggedStruct("Error", { message: Schema.String }),
]);
export type IsolatedBuildResponse = typeof IsolatedBuildResponse.Type;

const entryPaths = (input: rolldown.InputOption | undefined): string[] =>
  input === undefined
    ? []
    : typeof input === "string"
      ? [input]
      : Array.isArray(input)
        ? input
        : Object.values(input);

const prepareRequest = async (
  inputOptions: rolldown.InputOptions,
  outputOptions: rolldown.OutputOptions,
  extra: BundleExtraOptions | undefined,
): Promise<IsolatedBuildRequest> => {
  const { plugins, ...options } = inputOptions;
  const entries: Array<Record<string, string>> = [];
  const visit = async (option: rolldown.RolldownPluginOption): Promise<void> => {
    const plugin = await option;
    if (!plugin) return;
    if (Array.isArray(plugin)) {
      for (const child of plugin) await visit(child);
      return;
    }
    const content = virtualEntries.get(plugin);
    if (content === undefined) {
      throw new Error(
        `ALCHEMY_DEV_IMMUTABLE does not support the executable Rolldown plugin "${"name" in plugin ? plugin.name : "parallel plugin"}".`,
      );
    }
    entries.push(
      Object.fromEntries(
        entryPaths(options.input).map((entry) => {
          const absolute = resolve(options.cwd ?? initialCwd, entry);
          return [absolute, content(absolute)];
        }),
      ),
    );
  };
  await visit(plugins);
  // Native structured cloning preserves RegExp and binary assets and rejects
  // callbacks, rather than silently dropping a configured build option.
  try {
    return structuredClone({ inputOptions: options, outputOptions, extra, entries });
  } catch (cause) {
    throw new Error(
      "ALCHEMY_DEV_IMMUTABLE requires cloneable Rolldown options; callbacks are unsupported.",
      { cause },
    );
  }
};

/**
 * A compiler process owns its native module graph and exits before the result
 * is returned. Killing an interrupted build also releases that graph.
 */
export const build = (
  inputOptions: rolldown.InputOptions,
  outputOptions: rolldown.OutputOptions,
  extra: BundleExtraOptions | undefined,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const request = await prepareRequest(inputOptions, outputOptions, extra);
      if (signal.aborted) throw new Error("Immutable bundle build interrupted");
      const entry = fileURLToPath(
        new URL(`./IsolatedBuildWorker${moduleExtension(import.meta.url)}`, import.meta.url),
      );
      return await new Promise<BundleOutput>((resolve, reject) => {
        const child = childProcess.fork(entry, [], {
          execPath: process.execPath,
          execArgv: typeof Bun !== "undefined" ? [] : nodeLoaderArgs(entry),
          serialization: "advanced",
          stdio: ["ignore", "inherit", "inherit", "ipc"],
          cwd: initialCwd,
        });
        let response: IsolatedBuildResponse | undefined;
        let failure: Error | undefined;
        const abort = () => child.kill("SIGKILL");
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.once("message", (message: unknown) => {
          if (Schema.is(IsolatedBuildResponse)(message)) {
            response = message;
          } else {
            failure = new Error("Invalid immutable bundle compiler response");
            child.kill("SIGKILL");
          }
        });
        child.once("error", (error) => {
          failure = error;
          child.kill("SIGKILL");
        });
        child.once("close", (code, exitSignal) => {
          signal.removeEventListener("abort", abort);
          if (failure !== undefined) reject(failure);
          else if (response?._tag === "Error") reject(new Error(response.message));
          else if (code !== 0)
            reject(new Error(`Immutable bundle compiler exited (${exitSignal ?? code})`));
          else if (response?._tag === "Success") {
            const [first, ...rest] = response.output.files;
            resolve({ hash: response.output.hash, files: [first, ...rest] });
          } else reject(new Error("Immutable bundle compiler returned no output"));
        });
        try {
          child.send(request, (error) => {
            if (error !== null) {
              failure = error;
              child.kill("SIGKILL");
            }
          });
        } catch (cause) {
          failure = new Error("Failed to send immutable compiler input", { cause });
          child.kill("SIGKILL");
        }
      });
    },
    catch: bundleErrorFromUnknown,
  });
