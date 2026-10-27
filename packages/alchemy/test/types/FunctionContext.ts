import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Scope from "effect/Scope";
import type * as Runtime from "@/Runtime/Function.ts";

class InitDependency extends Context.Service<InitDependency, {}>()(
  "FunctionContext.InitDependency",
) {}

class InvocationDependency extends Context.Service<InvocationDependency, {}>()(
  "FunctionContext.InvocationDependency",
) {}

class CustomInitDependency extends Context.Service<CustomInitDependency, {}>()(
  "FunctionContext.CustomInitDependency",
) {}

class CustomInvocationDependency extends Context.Service<CustomInvocationDependency, {}>()(
  "FunctionContext.CustomInvocationDependency",
) {}

type Requirements<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const defaultContext: Runtime.FunctionContext;

const defaultDeferred = defaultContext.listen(
  Effect.gen(function* () {
    yield* CustomInitDependency;
    return () =>
      Effect.gen(function* () {
        yield* CustomInvocationDependency;
      });
  }),
);

type _DefaultRequirements = Expect<
  Equal<Requirements<typeof defaultDeferred>, CustomInitDependency | CustomInvocationDependency>
>;

declare const context: Runtime.FunctionContext<
  Scope.Scope | InitDependency,
  Scope.Scope | InvocationDependency
>;

const direct = context.listen(() =>
  Effect.gen(function* () {
    yield* Scope.Scope;
    yield* InvocationDependency;
    yield* CustomInvocationDependency;
  }),
);

type _DirectRequirements = Expect<Equal<Requirements<typeof direct>, CustomInvocationDependency>>;

const served = context.serve(
  Effect.gen(function* () {
    yield* Scope.Scope;
    yield* InvocationDependency;
    yield* CustomInvocationDependency;
    return HttpServerResponse.text("ok");
  }),
);

type _ServeRequirements = Expect<Equal<Requirements<typeof served>, CustomInvocationDependency>>;

const deferred = context.listen(
  Effect.gen(function* () {
    yield* Scope.Scope;
    yield* InitDependency;
    yield* CustomInitDependency;
    return () =>
      Effect.gen(function* () {
        yield* Scope.Scope;
        yield* InvocationDependency;
        yield* CustomInvocationDependency;
      });
  }),
);

type _DeferredRequirements = Expect<
  Equal<Requirements<typeof deferred>, CustomInitDependency | CustomInvocationDependency>
>;

const wrongPhase = context.listen(
  Effect.gen(function* () {
    yield* InvocationDependency;
    return () => Effect.asVoid(InitDependency);
  }),
);
type _WrongPhaseRequirements = Expect<
  Equal<Requirements<typeof wrongPhase>, InvocationDependency | InitDependency>
>;
