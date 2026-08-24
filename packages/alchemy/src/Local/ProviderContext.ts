/** @effect-diagnostics anyUnknownInErrorContext:off */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import type { ProviderService } from "../Provider.ts";
import type { ResourceLike } from "../Resource.ts";

/**
 * Wraps a provider so every lifecycle method runs with the given services.
 * Non-function members and method presence are preserved exactly.
 */
export const withProviderContext = <R extends ResourceLike>(
  provider: ProviderService<R>,
  services: Layer.Layer<any, never, never>,
): ProviderService<R> =>
  new Proxy(provider, {
    get: (target, prop) => {
      const value = (target as any)[prop];
      if (!Predicate.isFunction(value)) return value;
      return (...args: any[]) => {
        const result: unknown = value(...args);
        if (Stream.isStream(result)) {
          return Stream.provide(result, services);
        }
        if (Effect.isEffect(result)) {
          return Effect.provide(result, services);
        }
        return result;
      };
    },
  });

const isProviderService = (value: unknown): value is ProviderService<any> =>
  Predicate.hasProperty(value, "reconcile") &&
  Predicate.isFunction(value.reconcile);

/**
 * Builds a provider under an override context and keeps that context closest
 * to every lifecycle effect. Shared override layers are memoized through the
 * ambient build MemoMap.
 */
export const provideProviderContext = <ROut, E, RIn>(
  providerLayer: Layer.Layer<ROut, E, RIn>,
  services: Layer.Layer<any, any, never>,
): Layer.Layer<ROut, any, RIn> =>
  Layer.fromBuildMemo((memoMap, scope) =>
    Effect.gen(function* () {
      const ambient = yield* Effect.context<never>();
      const servicesContext = yield* Layer.buildWithMemoMap(
        services,
        memoMap,
        scope,
      );
      const servicesLayer = Layer.succeedContext(servicesContext);
      const built = yield* Layer.buildWithMemoMap(
        providerLayer.pipe(
          Layer.provide(servicesLayer),
          Layer.provide(Layer.succeedContext(ambient)),
        ) as Layer.Layer<any, any, never>,
        memoMap,
        scope,
      );
      const wrapped = new Map<string, any>();
      for (const [key, value] of built.mapUnsafe) {
        wrapped.set(
          key,
          isProviderService(value)
            ? withProviderContext(value, servicesLayer)
            : value,
        );
      }
      return Context.makeUnsafe(wrapped) as Context.Context<ROut>;
    }),
  ) as Layer.Layer<ROut, any, RIn>;
