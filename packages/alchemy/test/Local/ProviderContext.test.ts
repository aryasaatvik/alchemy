import { withProviderContext } from "@/Local/ProviderContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

describe("withProviderContext", () => {
  it.effect("preserves a provider method's receiver", () =>
    Effect.gen(function* () {
      const provider = {
        marker: "provider",
        reconcile(this: { marker: string }) {
          return Effect.succeed(this.marker);
        },
      } as any;
      const wrapped = withProviderContext(
        provider,
        Layer.empty as Layer.Layer<any, never, never>,
      );
      expect(yield* wrapped.reconcile({} as never)).toBe("provider");
    }),
  );
});
