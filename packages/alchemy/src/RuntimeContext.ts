import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { HttpEffect } from "./Http.ts";
import type { Output } from "./Output.ts";

export interface BaseRuntimeContext {
  Type: string;
  id: string;
  env: Record<string, any>;
  /**
   * Read a value by its (already-canonical) key. The key is used verbatim;
   * callers must {@link sanitizeKey} first. See {@link sanitizeKey}.
   */
  get<T>(key: string): Effect.Effect<T | undefined>;
  /**
   * Store an output under the given (already-canonical) key, returning the key.
   * The key is used verbatim; callers must {@link sanitizeKey} first.
   */
  set(id: string, output: Output): Effect.Effect<string>;
  exports?: Effect.Effect<Record<string, any>>;
  serve?<Req = never>(
    handler: HttpEffect<Req>,
    options?: { shape?: Record<string, unknown> },
  ): Effect.Effect<void, never, Req>;
  shape?: () => Record<string, unknown>;
  /** additional services to provide to the plan  */
  planServices?: Layer.Layer<any>;
  /**
   * Telemetry exporter Layer registered during init via
   * `Telemetry.layer(...)` / `Telemetry.layerOtlp(...)` (see Telemetry.ts).
   * The runtime bridges build it into every event's request scope,
   * overriding the env-driven default.
   */
  telemetry?: Layer.Layer<never, any, any>;
}

/**
 * Canonicalize a logical key into a key that is safe to use as the name of an
 * environment variable / binding (`[a-zA-Z][a-zA-Z0-9_]*`).
 *
 * `RuntimeContext.set`/`get` are dumb key/value stores: they read and write the
 * key **verbatim**. It is the *caller's* responsibility to hand them a
 * canonical key, since the caller is the one that knows the logical key may
 * contain `.`/`-` (e.g. a dotted config name from `Platform`, or an
 * `Output.toString()` like `"QueueSinkQueue.queueUrl"`). Callers run the key
 * through this before calling `set`/`get` so both sides agree.
 */
export const sanitizeKey = (key: string): string =>
  key.replaceAll(/[^a-zA-Z0-9]/g, "_");

/** Compact versioned discriminator for values serialized by {@link packEnvValue}. */
export const PACKED_ENV_VALUE_PREFIX = "~1";

/** Previous packed-value discriminator, retained for deployed runtime compatibility. */
const LEGACY_PACKED_ENV_VALUE_PREFIX = "alchemy:env:v1:";

const PACKED_ENV_VALUE_TAGS = ["s", "j", "r", "R"] as const;
type PackedEnvValueTag = (typeof PACKED_ENV_VALUE_TAGS)[number];

const compactTag = (raw: string): PackedEnvValueTag | undefined => {
  if (!raw.startsWith(PACKED_ENV_VALUE_PREFIX)) {
    return undefined;
  }
  const tag = raw.at(PACKED_ENV_VALUE_PREFIX.length);
  return PACKED_ENV_VALUE_TAGS.find((candidate) => candidate === tag);
};

/** Whether an environment string uses an explicit packed-value wire. */
export const isPackedEnvValue = (raw: string): boolean =>
  raw.startsWith(LEGACY_PACKED_ENV_VALUE_PREFIX) ||
  compactTag(raw) !== undefined;

/**
 * The wire format `RuntimeContext.set`/`get` use to carry a `Redacted` value
 * through an environment variable. `JSON.stringify(Redacted)` emits the
 * literal string `"<redacted>"` and loses the value, so secrets are
 * serialized as this marker and the runtime `get` path rebuilds the wrapper.
 */
export interface RedactedMarker {
  readonly _tag: "Redacted";
  readonly value: unknown;
}

/**
 * Detect the (already JSON-parsed) {@link RedactedMarker} shape. After
 * `JSON.parse` the marker is a plain object — `Redacted.isRedacted` is
 * always `false` on it — so detection is structural.
 */
export const isRedactedMarker = (value: unknown): value is RedactedMarker =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "Redacted" &&
  "value" in value;

/**
 * Serialize a binding value for an env var behind a compact versioned wire.
 * Ordinary strings remain verbatim. Strings beginning with a reserved prefix
 * are escaped, JSON values retain their types, and `Redacted<string>` uses a
 * raw-string payload so the common secret-binding path adds only three bytes.
 */
export const packEnvValue = (value: unknown): string => {
  if (Redacted.isRedacted(value)) {
    const redacted = Redacted.value(value);
    if (typeof redacted === "string") {
      return `${PACKED_ENV_VALUE_PREFIX}r${redacted}`;
    }
    const payload = JSON.stringify(redacted);
    if (payload === undefined) {
      throw new TypeError("Cannot pack undefined as an environment value");
    }
    return `${PACKED_ENV_VALUE_PREFIX}R${payload}`;
  }
  if (typeof value === "string") {
    return value.startsWith(PACKED_ENV_VALUE_PREFIX) ||
      value.startsWith(LEGACY_PACKED_ENV_VALUE_PREFIX)
      ? `${PACKED_ENV_VALUE_PREFIX}s${value}`
      : value;
  }
  const payload = JSON.stringify(value);
  if (payload === undefined) {
    throw new TypeError("Cannot pack undefined as an environment value");
  }
  return `${PACKED_ENV_VALUE_PREFIX}j${payload}`;
};

/**
 * Like {@link packEnvValue}, but a `Redacted` input keeps its `Redacted`
 * wrapper on the *outside* of the packed string, so deploy-time code can
 * route secrets through a dedicated channel (Cloudflare `secret_text`,
 * Secrets Store) instead of leaking them as plain env vars. The inner
 * payload still carries the marker for the runtime `get` accessor.
 */
export const packEnvValueKeepRedacted = (
  value: unknown,
): string | Redacted.Redacted<string> =>
  Redacted.isRedacted(value)
    ? Redacted.make(packEnvValue(value))
    : packEnvValue(value);

/**
 * Parse an env-var string produced by {@link packEnvValue} back into its
 * value. Unprefixed values and unknown compact tags are ordinary environment
 * strings and pass through verbatim, even when their contents are valid JSON.
 * The previous `alchemy:env:v1:` wire remains readable. `undefined` passes
 * through.
 *
 * Runtime `get` accessors MUST feed this from the raw environment
 * (`process.env[key]` / the platform env object) — never through
 * `Config.string`: the ambient runtime `ConfigProvider` reifies bound
 * values (unwrapping the marker before it could be detected here), and
 * during init the ambient provider is the interceptor installed in
 * `Platform.ts`, whose runtime branch calls back into `ctx.get(key)` —
 * resolving through `Config` would re-enter it for the same key and
 * recurse forever.
 */
export const unpackEnvValue = <T>(raw: string | undefined): T | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.startsWith(LEGACY_PACKED_ENV_VALUE_PREFIX)) {
    const parsed: unknown = JSON.parse(
      raw.slice(LEGACY_PACKED_ENV_VALUE_PREFIX.length),
    );
    return (
      isRedactedMarker(parsed) ? Redacted.make(parsed.value) : parsed
    ) as T;
  }
  const tag = compactTag(raw);
  if (tag === undefined) {
    return raw as unknown as T;
  }
  const payload = raw.slice(PACKED_ENV_VALUE_PREFIX.length + 1);
  switch (tag) {
    case "s":
      return payload as T;
    case "j":
      return JSON.parse(payload) as T;
    case "r":
      return Redacted.make(payload) as T;
    case "R":
      return Redacted.make(JSON.parse(payload)) as T;
  }
};

/**
 * Context of the runtime environment.
 *
 * E.g. the context of a running Worker, Task, Process, Function
 */
export class RuntimeContext extends Context.Service<
  RuntimeContext,
  BaseRuntimeContext
>()("RuntimeContext") {
  static phantom = Layer.empty as Layer.Layer<RuntimeContext>;
}

export const CurrentRuntimeContext = Effect.serviceOption(RuntimeContext).pipe(
  Effect.map(Option.getOrUndefined),
);
