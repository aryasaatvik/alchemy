import * as EffectContext from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import path from "pathe";

export class AlchemyContext extends EffectContext.Service<
  AlchemyContext,
  {
    dotAlchemy: string;
    dev: boolean;
    /**
     * Global default for the {@link import("./AdoptPolicy.ts").AdoptPolicy}
     * service. When `true`, resources without prior state will be adopted by
     * calling their `read` lifecycle operation; if that returns attributes
     * (and does not fail with `OwnedBySomeoneElse`), those attributes are
     * persisted as the resource's initial `created` state.
     *
     * The CLI's `--adopt` flag flows in through this field. Per-resource
     * overrides via the `adopt(enabled)` combinator still take precedence.
     */
    adopt: boolean;
    /**
     * When `true`, an out-of-date Cloudflare state store is upgraded
     * automatically instead of prompting for confirmation (and the upgrade
     * proceeds even in CI). The CLI's `--yes` flag flows in through this field.
     * @default false
     */
    updateStateStore?: boolean;
  }
>()("alchemy/Context") {}

/** Use the configured runtime directory, with a relative fallback for standalone callers. */
export const dotAlchemyDirectory = Effect.serviceOption(AlchemyContext).pipe(
  Effect.map((context) =>
    Option.isSome(context) ? context.value.dotAlchemy : ".alchemy",
  ),
);

export const AlchemyContextLive = Layer.effect(
  AlchemyContext,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = path.resolve(yield* dotAlchemyDirectory);
    yield* fs.makeDirectory(dir, { recursive: true });
    return {
      dotAlchemy: dir,
      updateStateStore: false,
      dev: false,
      adopt: false,
    };
  }),
);

/**
 * Re-root the ambient context's runtime directory. State, logs, local-provider
 * data, and build artifacts all resolve under `dataDir` (the CLI's
 * `--data-dir`), so concurrent evaluations of one project stay isolated.
 * Relative paths resolve from the process cwd.
 */
export const dataDirLayer = (dataDir: string) =>
  Layer.effect(
    AlchemyContext,
    Effect.gen(function* () {
      const context = yield* AlchemyContext;
      const fs = yield* FileSystem.FileSystem;
      const dir = path.resolve(dataDir);
      yield* fs.makeDirectory(dir, { recursive: true });
      return { ...context, dotAlchemy: dir };
    }),
  );

/** Provide {@link dataDirLayer} when a data directory was requested. */
export const withDataDir =
  (dataDir: string | undefined) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E | PlatformError,
    R | AlchemyContext | FileSystem.FileSystem
  > =>
    dataDir === undefined
      ? effect
      : Effect.provide(effect, dataDirLayer(dataDir));
