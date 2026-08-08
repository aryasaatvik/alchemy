/**
 * Runtime helpers consumed by generated bundle entrypoints (Cloudflare
 * Workers, Cloudflare Containers, AWS Lambda, …).
 *
 * Anything exported here runs *inside* the deployed function — keep the
 * surface tiny and dependency-light.
 */

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  isPackedEnvValue,
  sanitizeKey,
  unpackEnvValue,
} from "./RuntimeContext.ts";
import { asEffect } from "./Util/types.ts";

/**
 * Resolve the user's default-export entrypoint into a `Layer` for the
 * bundled runtime.
 *
 * `entrypoint` may be any of:
 *   - a `Layer` factory (`{ build: (...) => ... }`) — used as-is
 *   - an Alchemy `Platform`/`Worker` construct (now a real `Effect`)
 *   - a plain `Effect`
 *
 * Centralized so the inline ternary doesn't have to be re-emitted into
 * every bundle template (and accidentally rewritten to `x : x` by a bulk
 * replace, which silently swaps the class in for the Effect and bricks
 * every deployed worker/lambda).
 */
export const makeEntrypointLayer = (
  tag: any,
  entrypoint: any,
): Layer.Layer<any> => {
  if (typeof entrypoint?.build === "function") {
    return entrypoint;
  }
  return Layer.effect(tag, asEffect(entrypoint));
};

/**
 * Reify an explicitly packed env value into the string representation Effect
 * Config expects. Ordinary env strings are not packed and return `undefined`.
 */
const reifyPackedEnvString = (raw: string): string | undefined => {
  if (!isPackedEnvValue(raw)) {
    return undefined;
  }
  const unpacked = unpackEnvValue<unknown>(raw);
  const value = Redacted.isRedacted(unpacked)
    ? Redacted.value(unpacked)
    : unpacked;
  return typeof value === "string" ? value : JSON.stringify(value);
};

/**
 * Wrap a runtime's env-backed `ConfigProvider` so values that were
 * auto-bound by the deploy-time `Config` interceptor decode transparently.
 *
 * The engine can't know which config values are sensitive, so the
 * interceptor binds every `Config` read during Init onto the deploy target
 * as a secret, serialized behind the versioned `packEnvValue` wire. The
 * interceptor's runtime branch reifies those values for reads during Init,
 * but effects that run later (request handlers, nested layers) resolve
 * `Config` against the raw env-backed provider — without this wrapper,
 * `Config.number("PORT")` inside a handler sees the packed wire instead of
 * the source value and fails with a schema error.
 *
 * Two behaviors:
 * - Explicitly packed leaf values are restored to the source string before
 *   `Config` schemas decode them; ordinary env strings pass through untouched.
 * - On a miss, falls back to the flat `sanitizeKey`-canonicalized key
 *   (`my.key` → `my_key`) that the interceptor bound the value under, so
 *   config names with non-alphanumeric characters resolve at runtime too.
 */
export const reifyBoundConfigProvider = (
  base: ConfigProvider.ConfigProvider,
  env: Record<string, unknown>,
): ConfigProvider.ConfigProvider =>
  ConfigProvider.make((path) =>
    base.load(path).pipe(
      Effect.map((node) => {
        if (node?._tag === "Value") {
          const value = reifyPackedEnvString(node.value);
          return value === undefined ? node : ConfigProvider.makeValue(value);
        }
        if (node === undefined) {
          const raw = env[sanitizeKey(path.map((p) => p.toString()).join("_"))];
          if (typeof raw === "string") {
            return ConfigProvider.makeValue(reifyPackedEnvString(raw) ?? raw);
          }
        }
        return node;
      }),
    ),
  );
