import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Config from "effect/Config";
import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import type { PackageInstall } from "../../Bundle/InstalledPackages.ts";
import type { InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import type { PlatformServices } from "../../Platform.ts";
import { toSeconds, toWireDays } from "../../Util/Duration.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import type { DurableExecutionContext, DurableStep } from "./Durable.ts";
import {
  DURABLE_SDK_MODULE,
  encodeDurableEnvelope,
  makeDurableListener,
} from "./DurableBridge.ts";
import {
  Function,
  type FunctionProps,
  type FunctionServices,
  type HandlerContext,
} from "./Function.ts";

type TypeId = "AWS.Lambda.DurableFunction";
const TypeId = "AWS.Lambda.DurableFunction" as const;

/**
 * The services available inside a durable function's run body.
 *
 * The bridge provides all of them per durable invocation: `DurableStep`
 * powers `Durable.step`/`Durable.sleep`/`Durable.waitForCallback`,
 * `DurableExecutionContext` carries the execution ARN, `HandlerContext` is
 * the raw `lambda.Context`, and a fresh `Scope` scopes per-invocation
 * resources.
 *
 * Deliberately narrow: cloud clients (`Credentials`/`Region`-requiring
 * effects) are NOT provided to the body directly — resolve typed binding
 * clients in the init phase and call them inside `Durable.step`, which is
 * exactly the determinism law the replay model requires.
 */
export type DurableRunServices =
  | DurableStep
  | DurableExecutionContext
  | HandlerContext
  | Scope;

/**
 * A durable function implementation: a function from a typed `Input` payload
 * to an Effect producing the execution's `Result`. Code outside
 * `Durable.step` re-runs on every replay and must be deterministic.
 */
export type DurableFunctionImpl<Input = unknown, Result = unknown> = (
  input: Input,
) => Effect.Effect<Result, never, DurableRunServices>;

/**
 * Services satisfied by the DurableFunction's own machinery (or the engine)
 * and therefore excluded from the caller-facing requirements of the returned
 * Effect/Layer.
 */
export type DurableFunctionInitServices =
  | FunctionServices
  | PlatformServices
  | Function
  | DurableRunServices;

/**
 * Properties of an {@link DurableFunction | AWS.Lambda.DurableFunction}.
 *
 * A DurableFunction accepts every {@link FunctionProps | Function prop}
 * except `functionUrl` (every invocation of a durable function arrives as the
 * durable-execution envelope — there is no HTTP surface), plus the
 * `DurableConfig` tuning knobs below.
 */
export interface DurableFunctionProps extends Omit<
  FunctionProps,
  "functionUrl" | "durableConfig"
> {
  /**
   * Maximum total duration of a durable execution, from start to terminal
   * state (minimum 60 seconds, maximum 1 year). Rounded up to whole seconds.
   * @default 24 hours (AWS default)
   */
  executionTimeout?: Duration.Input;
  /**
   * How long completed execution history is retained (e.g. `"7 days"`;
   * 1–90 days). Rounded to whole days on the wire.
   * @default "14 days" (AWS default)
   */
  retentionPeriod?: Duration.Input;
}

/**
 * Options for starting a durable execution.
 */
export interface DurableStartOptions<Input = unknown> {
  /**
   * Idempotent execution name (`DurableExecutionName`): starting again with
   * the same name and payload reattaches to the existing execution; the same
   * name with a different payload fails with
   * `DurableExecutionAlreadyStartedException`.
   */
  name?: string;
  /** The typed input payload delivered to the durable function body. */
  params?: Input;
  /**
   * Function version or alias to pin the execution to. Durable executions
   * replay against the version they started on. `$LATEST` is suitable for
   * disposable development; production starts should target an immutable
   * numbered {@link Version} or a stable {@link Alias}.
   */
  qualifier?: string;
}

/**
 * A started durable execution reference.
 */
export interface DurableExecutionRef {
  /** ARN of the durable execution (when returned by the Invoke response). */
  executionArn: string | undefined;
  statusCode: number | undefined;
}

/**
 * The typed durable-execution handle: start, inspect, stop, and complete
 * callbacks of durable executions of this function. Returned by
 * `yield* MyDurableFunction` (as part of {@link DurableFunction}) and, inside
 * the function's own init phase, by {@link DurableFunctionScope}.
 */
export interface DurableFunctionHandle<Input = unknown, Result = unknown> {
  Type: TypeId;
  name: string;
  /** @internal phantom */
  Result?: Result;
  /**
   * Start a durable execution (async `Invoke` with the alchemy payload
   * envelope). Returns immediately; the execution progresses through
   * checkpointed re-invocations.
   */
  start(
    options?: DurableStartOptions<Input>,
  ): Effect.Effect<DurableExecutionRef, Lambda.InvokeError>;
  /** Fetch the execution's status/result. */
  get(
    executionArn: string,
  ): Effect.Effect<
    Lambda.GetDurableExecutionResponse,
    Lambda.GetDurableExecutionError
  >;
  /** List executions of this function, optionally filtered by name/status. */
  list(options?: {
    name?: string;
    statuses?: Lambda.ExecutionStatus[];
    /** Function version or alias whose durable executions should be listed. */
    qualifier?: string;
  }): Effect.Effect<
    Lambda.ListDurableExecutionsByFunctionResponse,
    Lambda.ListDurableExecutionsByFunctionError
  >;
  /** Stop a running execution. */
  stop(
    executionArn: string,
    error?: Lambda.ErrorObject,
  ): Effect.Effect<
    Lambda.StopDurableExecutionResponse,
    Lambda.StopDurableExecutionError
  >;
  /** Complete a `Durable.waitForCallback` from the outside. */
  sendCallbackSuccess(
    callbackId: string,
    result?: unknown,
  ): Effect.Effect<void, Lambda.SendDurableExecutionCallbackSuccessError>;
  sendCallbackFailure(
    callbackId: string,
    error?: Lambda.ErrorObject,
  ): Effect.Effect<void, Lambda.SendDurableExecutionCallbackFailureError>;
  sendCallbackHeartbeat(
    callbackId: string,
  ): Effect.Effect<void, Lambda.SendDurableExecutionCallbackHeartbeatError>;
}

/**
 * The value produced by `yield* MyDurableFunction`: the typed
 * {@link DurableFunctionHandle} plus references to the underlying
 * {@link Function} resource and its key attributes.
 */
export interface DurableFunction<
  Input = unknown,
  Result = unknown,
> extends DurableFunctionHandle<Input, Result> {
  /** The underlying Lambda {@link Function} resource owned by this wrapper. */
  function: Function;
  /** Physical name of the underlying Lambda function. */
  functionName: Function["functionName"];
  /** ARN of the underlying Lambda function. */
  functionArn: Function["functionArn"];
}

/**
 * Inside a DurableFunction's init phase, resolves the function's own
 * {@link DurableFunctionHandle} (e.g. for chained self-starts). Also what
 * `yield* AWS.Lambda.DurableFunction` (the bare namespace value) resolves.
 */
export class DurableFunctionScope extends Context.Service<
  DurableFunctionScope,
  DurableFunctionHandle
>()("AWS.Lambda.DurableFunctionScope") {}

export interface DurableFunctionClass {
  <_Self>(): {
    <Input = unknown, Result = unknown, PropsReq = never, InitReq = never>(
      id: string,
      props:
        | InputProps<DurableFunctionProps>
        | Effect.Effect<
            InputProps<DurableFunctionProps>,
            ConfigError,
            PropsReq
          >,
      impl: Effect.Effect<
        DurableFunctionImpl<Input, Result>,
        ConfigError,
        InitReq
      >,
    ): Effect.Effect<
      DurableFunction<Input, Result>,
      never,
      | Function["Providers"]
      | Exclude<PropsReq | InitReq, DurableFunctionInitServices>
    > & {
      new (_: never): DurableFunctionImpl<Input, Result>;
    };
    <const Id extends string>(
      id: Id,
    ): Effect.Effect<DurableFunction, never, Function["Providers"]> & {
      make<
        Input = unknown,
        Result = unknown,
        PropsReq = never,
        InitReq = never,
      >(
        props:
          | InputProps<DurableFunctionProps>
          | Effect.Effect<
              InputProps<DurableFunctionProps>,
              ConfigError,
              PropsReq
            >,
        impl: Effect.Effect<
          DurableFunctionImpl<Input, Result>,
          ConfigError,
          InitReq
        >,
      ): Layer.Layer<
        _Self,
        never,
        | Function["Providers"]
        | Exclude<PropsReq | InitReq, DurableFunctionInitServices>
      >;
      new (_: never): {};
    };
  };
  <Input = unknown, Result = unknown, PropsReq = never, InitReq = never>(
    id: string,
    props:
      | InputProps<DurableFunctionProps>
      | Effect.Effect<InputProps<DurableFunctionProps>, ConfigError, PropsReq>,
    impl: Effect.Effect<
      DurableFunctionImpl<Input, Result>,
      ConfigError,
      InitReq
    >,
  ): Effect.Effect<
    DurableFunction<Input, Result>,
    never,
    | Function["Providers"]
    | Exclude<PropsReq | InitReq, DurableFunctionInitServices>
  >;
}

/**
 * Where the composed init stashes the {@link DurableFunction} value on the
 * owned Function instance so `yield*` of any authoring form can produce it.
 * A symbol key passes through the Resource proxy untouched (string props
 * fabricate `Output.PropExpr` accessors).
 */
const DurableHandleKey = Symbol.for("alchemy/AWS.Lambda.DurableFunction");

/**
 * Vendor the Durable Execution SDK into the artifact. `build.install` roots
 * are excluded from the bundle and npm-installed into the zip targeting the
 * function's architecture, so this single entry both externalizes the SDK
 * (the bridge dynamic-imports it at runtime) and ships it. Respects an
 * explicit user entry (e.g. a pinned version).
 */
const withDurableSdkInstall = (
  install: PackageInstall | undefined,
): PackageInstall => {
  if (install === undefined) {
    return [DURABLE_SDK_MODULE];
  }
  if (Array.isArray(install)) {
    return install.includes(DURABLE_SDK_MODULE)
      ? install
      : [...install, DURABLE_SDK_MODULE];
  }
  const record = install as Readonly<Record<string, string>>;
  return DURABLE_SDK_MODULE in record
    ? record
    : { ...record, [DURABLE_SDK_MODULE]: "*" };
};

/**
 * Lower DurableFunction props onto the base Function's props: split off the
 * DurableConfig knobs into the internal wire-level `durableConfig` channel,
 * disable the Function URL (durable invocations are the only surface), and
 * vendor the Durable Execution SDK.
 */
const mapDurableProps = (props: DurableFunctionProps): FunctionProps => {
  const { executionTimeout, retentionPeriod, build, ...rest } =
    props ?? ({} as DurableFunctionProps);
  const executionTimeoutSeconds = toSeconds(executionTimeout);
  const retentionPeriodDays = toWireDays(retentionPeriod);
  return {
    ...rest,
    // Every invocation of a DurableConfig'd function arrives as the durable
    // envelope — a Function URL could never be served.
    functionUrl: false,
    build: {
      ...build,
      install: withDurableSdkInstall(build?.install),
    },
    durableConfig: {
      ...(executionTimeoutSeconds !== undefined
        ? { ExecutionTimeout: executionTimeoutSeconds }
        : {}),
      ...(retentionPeriodDays !== undefined
        ? { RetentionPeriodInDays: retentionPeriodDays }
        : {}),
    },
  };
};

const mapDurablePropsInput = (props: unknown) =>
  Effect.isEffect(props)
    ? Effect.map(props as Effect.Effect<DurableFunctionProps>, mapDurableProps)
    : mapDurableProps(props as DurableFunctionProps);

/** @internal */
export const makeDurableListRequest = (
  functionName: string,
  options?: {
    name?: string;
    statuses?: Lambda.ExecutionStatus[];
    qualifier?: string;
  },
): Lambda.ListDurableExecutionsByFunctionRequest => {
  const name = options?.name;
  const qualifier = options?.qualifier;

  // Lambda scopes a DurableExecutionName to the function, not one version.
  // It rejects the exact-name filter whenever a qualifier is present, whether
  // supplied separately or embedded in FunctionName. Exact-name lookups must
  // therefore use the unqualified function identity.
  if (name !== undefined && qualifier !== undefined) {
    return {
      FunctionName: functionName,
      DurableExecutionName: name,
      Statuses: options?.statuses,
    };
  }

  return {
    FunctionName: functionName,
    DurableExecutionName: name,
    Statuses: options?.statuses,
    Qualifier: qualifier,
  };
};

/** @internal */
export const durableSelfManagementActions = {
  list: ["lambda:ListDurableExecutionsByFunction"],
  execution: [
    "lambda:GetDurableExecution",
    "lambda:StopDurableExecution",
    "lambda:SendDurableExecutionCallbackSuccess",
    "lambda:SendDurableExecutionCallbackFailure",
    "lambda:SendDurableExecutionCallbackHeartbeat",
  ],
} as const;

/** @internal */
export const makeDurableSelfManagementPolicyStatements = (
  functionArn: string | Output.Output<string>,
  qualifiedFunctionArn: string | Output.Output<string>,
) => [
  {
    Effect: "Allow" as const,
    Action: [...durableSelfManagementActions.list],
    Resource: [functionArn, qualifiedFunctionArn],
  },
  {
    Effect: "Allow" as const,
    Action: [...durableSelfManagementActions.execution],
    Resource: [qualifiedFunctionArn],
  },
];

const makeDurableHandle = (options: {
  name: string;
  host: Function;
  functionName: Effect.Effect<string>;
}) =>
  Effect.gen(function* () {
    const { name, host, functionName } = options;
    // Resolve the distilled operations once at init — they close over the
    // ambient Credentials/Region/HttpClient so the handle's runtime
    // callables need no cloud services of their own.
    const invoke = yield* Lambda.invoke;
    const getDurableExecution = yield* Lambda.getDurableExecution;
    const listDurableExecutionsByFunction =
      yield* Lambda.listDurableExecutionsByFunction;
    const stopDurableExecution = yield* Lambda.stopDurableExecution;
    const sendCallbackSuccess =
      yield* Lambda.sendDurableExecutionCallbackSuccess;
    const sendCallbackFailure =
      yield* Lambda.sendDurableExecutionCallbackFailure;
    const sendCallbackHeartbeat =
      yield* Lambda.sendDurableExecutionCallbackHeartbeat;

    const handle: DurableFunctionHandle<any, any> = {
      Type: TypeId,
      name,
      start: (options) =>
        Effect.gen(function* () {
          const resolvedFunctionName = yield* functionName;
          const response = yield* invoke({
            FunctionName: resolvedFunctionName,
            InvocationType: "Event",
            DurableExecutionName: options?.name,
            Qualifier: options?.qualifier,
            Payload: encodeDurableEnvelope(name, options?.params),
          });
          return {
            executionArn: response.DurableExecutionArn,
            statusCode: response.StatusCode,
          };
        }),
      get: (executionArn) =>
        getDurableExecution({ DurableExecutionArn: executionArn }),
      list: (options) =>
        Effect.gen(function* () {
          const resolvedFunctionName = yield* functionName;
          return yield* listDurableExecutionsByFunction(
            makeDurableListRequest(resolvedFunctionName, options),
          );
        }),
      stop: (executionArn, error) =>
        stopDurableExecution({
          DurableExecutionArn: executionArn,
          Error: error,
        }),
      sendCallbackSuccess: (callbackId, result) =>
        sendCallbackSuccess({
          CallbackId: callbackId,
          Result: result === undefined ? undefined : JSON.stringify(result),
        }).pipe(Effect.asVoid),
      sendCallbackFailure: (callbackId, error) =>
        sendCallbackFailure({
          CallbackId: callbackId,
          Error: error,
        }).pipe(Effect.asVoid),
      sendCallbackHeartbeat: (callbackId) =>
        sendCallbackHeartbeat({ CallbackId: callbackId }).pipe(Effect.asVoid),
    };

    return {
      ...handle,
      function: host,
      functionName: host.functionName,
      functionArn: host.functionArn,
    } satisfies DurableFunction<any, any>;
  });

/**
 * Build a management-plane handle for a Durable Function owned by another
 * Lambda. Unlike the function's self handle, this binds the target's deployed
 * physical name into the ambient caller Function.
 */
export const reference = <Input = unknown, Result = unknown>(
  durable: DurableFunction<Input, Result>,
) =>
  Effect.gen(function* () {
    const functionName = yield* durable.functionName;
    return yield* makeDurableHandle({
      name: durable.name,
      host: durable.function,
      functionName,
    });
  });

const resolveDurableHandle = (id: string) => (instance: unknown) => {
  const handle = (instance as Record<symbol, unknown> | undefined)?.[
    DurableHandleKey
  ];
  if (handle !== undefined) {
    return Effect.succeed(handle as DurableFunction<any, any>);
  }
  if (instance !== undefined) {
    // A nested DurableFunction is a reference when another platform is
    // booting at runtime. Its handler init must not run in the parent, but
    // callers still need the management-plane handle backed by its resource.
    const host = instance as Function;
    return Effect.gen(function* () {
      // A nested handle crosses a Lambda boundary, so bind the child's
      // deployed name into the parent while its init graph is being built.
      const functionName = yield* host.functionName;
      return yield* makeDurableHandle({ name: id, host, functionName });
    });
  }
  return Effect.die(
    new Error(
      `AWS.Lambda.DurableFunction<${id}> has no durable handle — provide ` +
        `its implementation (\`${id}.make(props, impl)\` or an inline ` +
        `form) before yielding it.`,
    ),
  );
};

/**
 * Compose the user's orchestrator init effect into the owned Function's init
 * effect: resolve the durable management-plane clients, self-bind the
 * checkpoint-protocol IAM onto the function's own execution role, register
 * the durable listener on the owned entrypoint, and stash the typed handle
 * for `yield* MyDurableFunction`.
 */
const composeDurableImpl = (
  name: string,
  impl: Effect.Effect<DurableFunctionImpl<any, any>, any, any>,
): Effect.Effect<void, any, any> =>
  Effect.gen(function* () {
    // Self: the Function resource this wrapper owns (the Platform machinery
    // provides `Function.Self` during its own init).
    const host = yield* Function;

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      // Self-binding: the statements land on this function's own execution
      // role through the standard bindings channel (precreate makes the stub,
      // reconcile applies the collected bindings).
      yield* host.bind`Allow(${host}, AWS.Lambda.DurableFunction(${name}))`({
        policyStatements: [
          // The checkpoint/replay protocol the Durable Execution SDK
          // drives from inside the handler.
          {
            Effect: "Allow",
            Action: [
              "lambda:CheckpointDurableExecution",
              "lambda:GetDurableExecutionState",
            ],
            Resource: [
              host.functionArn,
              Output.interpolate`${host.functionArn}:*`,
            ],
          },
          // Self-start (handle.start) and chained self-invokes.
          {
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: [
              host.functionArn,
              Output.interpolate`${host.functionArn}:*`,
            ],
          },
          // Listing is authorized against the function and its qualified
          // version/alias ARNs. Execution management and the callback methods
          // exposed by DurableFunctionHandle are scoped to executions
          // belonging to this function. History remains ungranted because the
          // handle does not expose it.
          ...makeDurableSelfManagementPolicyStatements(
            host.functionArn,
            Output.interpolate`${host.functionArn}:*`,
          ),
        ],
      });
    }

    // Lambda already supplies its own physical name at runtime. Reading that
    // standard environment value keeps the self-handle out of the Function's
    // deploy-time props; binding host.functionName here would make the
    // Function depend on its own output and deadlock plan resolution.
    const handle = yield* makeDurableHandle({
      name,
      host,
      functionName: Config.string("AWS_LAMBDA_FUNCTION_NAME").pipe(
        Effect.orDie,
      ),
    });

    // Publish the reference before evaluating the handler init. The init can
    // resolve DurableFunctionScope for chained starts, while other platforms
    // can synthesize the same reference without running this handler init.
    (host as unknown as Record<symbol, unknown>)[DurableHandleKey] = handle;

    // Resolve the body function. Bindings resolved in the impl's init close
    // over their services; the returned closure's only leftover requirements
    // are DurableRunServices, provided per invocation by the bridge.
    const fn = yield* (
      impl as Effect.Effect<DurableFunctionImpl<any, any>>
    ).pipe(Effect.provideService(DurableFunctionScope, handle));

    yield* host.listen(
      makeDurableListener({
        name,
        run: (input) => fn(input) as Effect.Effect<unknown>,
      }),
    );
  });

/**
 * An AWS Lambda Durable Function — a code-first, replay-based orchestrator
 * that IS a durable Lambda Function. `AWS.Lambda.DurableFunction` is a
 * wrapper of {@link Function}: it owns the underlying Lambda function,
 * configures its `DurableConfig` at `CreateFunction` (durability is a
 * create-time property — a DurableFunction is always durable), registers the
 * durable-execution listener on the owned entrypoint, self-binds the
 * checkpoint-protocol IAM (`lambda:CheckpointDurableExecution`,
 * `lambda:GetDurableExecutionState`) onto the execution role, and vendors the
 * open-source `@aws/durable-execution-sdk-js` into the artifact (install it
 * in your project: `npm i @aws/durable-execution-sdk-js`).
 *
 * Executions progress by checkpoint + replay: a `Durable.sleep` or
 * `Durable.waitForCallback` suspends the execution with zero compute billed
 * until Lambda re-invokes the same function version to resume, and completed
 * `Durable.step`s replay from the checkpoint log without re-executing.
 *
 * Every invocation of a durable function arrives as the durable-execution
 * envelope, so a DurableFunction has no HTTP surface (`functionUrl` is disabled) —
 * it does one thing: run durable orchestrations. Reusing a logical id
 * between a plain `Function` and a `DurableFunction` replaces the physical
 * function (DurableConfig cannot be flipped in place).
 *
 * @resource
 * @section Defining a Durable Function
 * @example Class form with steps and a durable sleep
 * ```typescript
 * export class OrderFlow extends AWS.Lambda.DurableFunction<OrderFlow>()(
 *   "OrderFlow",
 *   {
 *     main: import.meta.url,
 *     executionTimeout: "1 hour",
 *     retentionPeriod: "7 days",
 *   },
 *   Effect.gen(function* () {
 *     // init: resolve typed binding clients (IAM lands on this function's role)
 *     const putItem = yield* AWS.DynamoDB.PutItem(table);
 *
 *     return Effect.fn(function* (input: { orderId: string }) {
 *       const reserved = yield* AWS.Lambda.Durable.step(
 *         "reserve",
 *         putItem({ Item: { pk: { S: input.orderId } } }).pipe(Effect.orDie),
 *         { retry: { limit: 3, delay: "5 seconds" } },
 *       );
 *       yield* AWS.Lambda.Durable.sleep("cooldown", "10 minutes");
 *       return { orderId: input.orderId, reserved };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @example Tag + default export (entrypoint form)
 * ```typescript
 * // order-flow.ts — `main` points at this module
 * export class OrderFlow extends AWS.Lambda.DurableFunction<OrderFlow>()(
 *   "OrderFlow",
 * ) {}
 *
 * export default OrderFlow.make(
 *   { main: import.meta.url, executionTimeout: "1 hour" },
 *   Effect.gen(function* () {
 *     return Effect.fn(function* (input: { orderId: string }) {
 *       return yield* AWS.Lambda.Durable.step("work", doWork(input));
 *     });
 *   }),
 * );
 * ```
 *
 * @example Inline effect form
 * ```typescript
 * const flow = yield* AWS.Lambda.DurableFunction(
 *   "OrderFlow",
 *   { main: "./src/order-flow.ts" },
 *   Effect.gen(function* () {
 *     return Effect.fn(function* (input: { orderId: string }) {
 *       return yield* AWS.Lambda.Durable.step("work", doWork(input));
 *     });
 *   }),
 * );
 * ```
 *
 * @section Starting and Monitoring Executions
 * @example Starting an execution
 * ```typescript
 * const orders = yield* OrderFlow;
 * const ref = yield* orders.start({
 *   name: "order-123", // idempotent start
 *   params: { orderId: "123" },
 *   qualifier: "live",
 * });
 * ```
 *
 * @example Publish and promote for production
 * ```typescript
 * const orders = yield* OrderFlow;
 * const version = yield* AWS.Lambda.Version("OrderFlowVersion", {
 *   function: orders.function,
 * });
 * yield* AWS.Lambda.Alias("OrderFlowLive", {
 *   version,
 *   aliasName: "live",
 * });
 *
 * const ref = yield* orders.start({
 *   name: "order-123",
 *   params: { orderId: "123" },
 *   qualifier: "live",
 * });
 * ```
 *
 * @example Checking status
 * ```typescript
 * const execution = yield* orders.get(ref.executionArn!);
 * // execution.Status: "RUNNING" | "SUCCEEDED" | "FAILED" | ...
 * ```
 *
 * @section External Callbacks
 * @example Waiting for an approval
 * ```typescript
 * const approval = yield* AWS.Lambda.Durable.waitForCallback<{ ok: boolean }>(
 *   "approve",
 *   (callbackId) => storeCallbackId(callbackId),
 *   { timeout: "1 day" },
 * );
 * ```
 */
export const DurableFunction: DurableFunctionClass = taggedFunction(
  DurableFunctionScope,
  ((
    ...args:
      | []
      | [id: string]
      | [id: string, props: unknown, impl: Effect.Effect<any, any, any>]
  ) => {
    if (args.length === 0) {
      // `DurableFunction<Self>()` — the binder for the class/tag forms.
      return DurableFunction;
    }
    const [id, props, impl] = args;
    if (impl === undefined) {
      // Tag form: `class OrderFlow extends DurableFunction<OrderFlow>()("OrderFlow") {}`
      // + `export default OrderFlow.make(props, impl)`.
      const fnTag = (Function as any)()(id);
      return Object.assign(
        function (props: unknown, impl: Effect.Effect<any, any, any>) {
          return Effect.flatMap(
            fnTag(mapDurablePropsInput(props), composeDurableImpl(id, impl)),
            resolveDurableHandle(id),
          );
        },
        fnTag,
        {
          make: (props: unknown, impl: Effect.Effect<any, any, any>) =>
            fnTag.make(
              mapDurablePropsInput(props),
              composeDurableImpl(id, impl),
            ),
        },
        Effectable.Prototype({
          label: `${TypeId}<${id}>`,
          evaluate: () =>
            Effect.flatMap(
              Effect.serviceOption(fnTag.Self),
              Option.match({
                onNone: () => resolveDurableHandle(id)(undefined),
                onSome: resolveDurableHandle(id),
              }),
            ),
        }),
      );
    }
    // Inline forms (eager effect / inline class): delegate to the Function
    // platform with lowered props and the composed durable init.
    return effectClass(
      Effect.flatMap(
        (Function as any)(
          id,
          mapDurablePropsInput(props),
          composeDurableImpl(id, impl),
        ) as Effect.Effect<unknown>,
        resolveDurableHandle(id),
      ),
    );
  }) as any,
);
