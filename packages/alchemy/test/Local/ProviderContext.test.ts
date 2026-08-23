import { provideProviderContext } from "@/Local/ProviderContext.ts";
import * as Provider from "@/Provider.ts";
import { Resource } from "@/Resource.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "alchemy-test";

interface TestResource extends Resource<
  "Local.ProviderContext.Test",
  {},
  { value: string }
> {}

const TestResource = Resource<TestResource>("Local.ProviderContext.Test");

class Value extends Context.Service<Value, string>()(
  "Local.ProviderContext.Test.Value",
) {}

const provider = Provider.succeed(TestResource, {
  list: () => Effect.map(Value, (value) => [{ value }]),
  reconcile: () => Effect.map(Value, (value) => ({ value })),
  delete: () => Effect.void,
});

describe("Local.ProviderContext", () => {
  it.effect("provides the override to provider lifecycle effects", () =>
    Effect.gen(function* () {
      const service = yield* Provider.findProvider(TestResource);
      const resources = yield* service.list();

      expect(resources).toEqual([{ value: "override" }]);
    }).pipe(
      Effect.provide(
        provideProviderContext(provider, Layer.succeed(Value, "override")).pipe(
          Layer.provide(Layer.succeed(Value, "ambient")),
        ),
      ),
    ),
  );
});
