/**
 * Minimal Bun surface used by this package.
 *
 * `@types/bun` (via `bun-types`) declares `Headers`, `WebSocket`, and other
 * globals through `UseLibDomIfAvailable`, which yields Bun's fallback shapes
 * when no DOM lib is present and clobbers `@cloudflare/workers-types`. This
 * package is workers-first, so `workers-types` must own those globals. We only
 * use `Bun.spawn`, `Bun.file`, and feature-detect `Bun`, so declare exactly
 * that instead of pulling the whole Bun global set.
 */
declare var Bun: {
  file(
    path: string | number | URL | Blob | undefined,
    options?: unknown,
  ): Blob & { stream(): ReadableStream<Uint8Array> };
  spawn(options: {
    cmd: readonly string[];
    env?: Record<string, string | undefined>;
    stdio?: unknown;
    killSignal?: string;
  }): {
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly stdio: ReadonlyArray<string | number | Blob | URL | undefined>;
    readonly exited: Promise<number>;
    readonly exitCode: number | null;
    readonly signalCode: any;
    kill(signal?: string): void;
  };
};
