import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * Provider-group configuration a stack resolved for its local providers,
 * keyed by provider namespace (e.g. `"AWS"`). Values must be plain JSON:
 * the dev sidecar receives them with the session environment (see
 * `RpcServerEnvironment.SessionEnvironment`), so a local provider built in
 * the sidecar reads the same configuration as one built in the stack
 * process. Each namespace owns and validates its own entry.
 */
export class ProviderSessionConfig extends Context.Service<
  ProviderSessionConfig,
  Readonly<Record<string, unknown>>
>()("alchemy/Local/ProviderSessionConfig") {}

/**
 * Set one namespace's entry, keeping the entries other provider groups
 * placed below this layer.
 */
export const layer = (namespace: string, value: unknown) =>
  Layer.effect(
    ProviderSessionConfig,
    Effect.serviceOption(ProviderSessionConfig).pipe(
      Effect.map((current) => ({
        ...Option.getOrElse(current, () => ({})),
        [namespace]: value,
      })),
    ),
  );

/** One namespace's entry, or `undefined` when no stack configured it. */
export const get = (namespace: string): Effect.Effect<unknown> =>
  Effect.serviceOption(ProviderSessionConfig).pipe(
    Effect.map((config) =>
      Option.isSome(config) ? config.value[namespace] : undefined,
    ),
  );
