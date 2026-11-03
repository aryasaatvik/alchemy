import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Lambda from "@distilled.cloud/aws/lambda";
import type { InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import {
  CurrentActivity,
  decodeExit,
  decodeResult,
  encodeExit,
  encodeResult,
  makeCurrentActivity,
  payloadCodec,
} from "alchemy/WorkflowEncoding";
import {
  type Implemented,
  implemented,
  StartReceipt,
  ExecutionReference,
  NotYetWaiting,
} from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Exit from "effect/Exit";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Activity, Workflow, WorkflowEngine } from "effect/workflow";
import * as AWSBindings from "../AWSBindings.ts";
import type { Alias } from "./Alias.ts";
import {
  DurableStep,
  DurableStepAttempt,
  type DurableCallbackConfig,
  type DurableRetryPolicy,
} from "./Durable.ts";
import {
  AmbiguousDurableExecutionIdentity,
  DurableExecutionIdentityUnavailable,
  DurableFunction,
  type DurableFunctionImpl,
  type DurableFunctionInitServices,
  type DurableFunctionProps,
} from "./DurableFunction.ts";
import { Function } from "./Function.ts";
import { qualifierOf } from "./QualifiedArn.ts";

type WorkflowNames<W> = W extends Workflow.Workflow<infer Name, any, any, any> ? Name : never;

type ImplementedEach<Name> = Name extends string ? Implemented<Name> : never;

/** Workflows a host lists whose implementation is missing from the Layer it's given. */
type Missing<ROut, Name> = Name extends string
  ? Implemented<Name> extends ROut
    ? never
    : Name
  : never;

type ImplementsAll<ROut, Name> = [Missing<ROut, Name>] extends [never]
  ? unknown
  : { readonly "Missing workflow implementations": Missing<ROut, Name> };

/**
 * A Lambda durable function that runs workflows: the class a
 * `WorkflowFunction` declares. `yield*` it for the Lambda function itself.
 */
export interface WorkflowFunctionClass<
  Self,
  W extends Workflow.Any = Workflow.Any,
> extends Effect.Effect<Function, never, Function["Providers"]> {
  readonly LogicalId: string;
  /** The workflows this function runs. */
  readonly workflows: ReadonlyArray<W>;
  /**
   * Deploy the function with the Layer that implements its workflows. The
   * Layer must implement every workflow the function lists.
   */
  make<ROut, E, RIn, PropsReq = never>(
    props:
      | InputProps<DurableFunctionProps>
      | Effect.Effect<InputProps<DurableFunctionProps>, ConfigError, PropsReq>,
    workflows: Layer.Layer<ROut, E, RIn> & ImplementsAll<ROut, WorkflowNames<W>>,
  ): Layer.Layer<
    Self,
    never,
    | Function["Providers"]
    | Exclude<PropsReq | RIn, DurableFunctionInitServices | WorkflowEngine.WorkflowEngine>
  >;
  new (_: never): {};
}

/**
 * A Lambda durable function that runs Effect workflows. Each run is one
 * durable execution of the function, named after the workflow and its
 * execution id.
 *
 * Steps run as durable steps, so a finished step's result is replayed rather
 * than run again. `DurableClock.sleep` is a durable wait: the invocation ends,
 * and Lambda invokes the function again when it's due, with no compute billed
 * in between. `DurableDeferred.await` waits for a callback, completed with a
 * run's `signal`. A workflow's child workflows run in the same function.
 *
 * Activities retain services and telemetry provided at their call site across
 * the native SDK callback. Each receives its own WorkflowInstance and attempt.
 *
 * Activities (name + attempt), clocks and deferreds are memoized by name within
 * each execution, matching Effect's identity semantics. Loop iterations must use
 * distinct names, for example `apply/${pass}`. Reusing a name replays its result.
 *
 * Complete an open wait with Workflows.completeDeferred or a Run's complete
 * API: an absent or closed wait returns typed NotYetWaiting, with no retry or
 * buffering. Plain DurableDeferred.done and the legacy Run.signal API raise a
 * clear defect in that case.
 * Lambda history is the sole source of callback state.
 *
 * Use ActivityRetry annotations for durable SDK retries. Native Activity.retry
 * is in-process only and is not durable on this engine. DurableDeferred.raceAll
 * is unsupported on this engine; use DeferredWait for callback deadlines.
 *
 * Other functions start and read its runs with
 * {@link DurableFunctionEngine | AWS.Lambda.DurableFunctionEngine}.
 *
 * ### Declaring a workflow function
 * **Example:** One function for the order workflows
 * ```typescript
 * // src/OrderWorkflows.ts
 * import * as AWS from "@alchemy.run/aws";
 * import * as Layer from "effect/Layer";
 * import { PlaceOrder, PlaceOrderLive, RefundOrder, RefundOrderLive } from "./orders.ts";
 *
 * export class OrderWorkflows extends AWS.Lambda.WorkflowFunction<OrderWorkflows>()(
 *   "OrderWorkflows",
 *   { workflows: [PlaceOrder, RefundOrder] },
 * ) {}
 *
 * export default OrderWorkflows.make(
 *   { main: import.meta.url, executionTimeout: "7 days" },
 *   Layer.mergeAll(PlaceOrderLive, RefundOrderLive),
 * );
 * ```
 *
 * The workflow Layer must implement every workflow the function lists: leaving one out
 * is a type error.
 *
 * @resource
 */
export const WorkflowFunction =
  <Self>() =>
  <const W extends ReadonlyArray<Workflow.Any>>(
    id: string,
    options: {
      /** The workflows this function runs. */
      readonly workflows: W;
    },
  ): WorkflowFunctionClass<Self, W[number]> => {
    const durable = (DurableFunction as any)()(id);
    const make = durable.make;
    // The Lambda function, from anywhere: its own init, or another function's.
    const self = (Function as any)()(id);
    return Object.assign(
      durable,
      {
        workflows: options.workflows,
        make: (props: unknown, workflows: Layer.Layer<any, any, any>) =>
          make(props, makeWorkflowRunner(workflows)),
      },
      Effectable.Prototype({
        label: `AWS.Lambda.WorkflowFunction<${id}>`,
        evaluate: () => self,
      }),
    );
  };

/**
 * Lambda callback timeout and heartbeat deadline for the enclosed deferred await.
 * Provide with Effect.provideService(DeferredWait, { timeout: "1 day" }). A timeout
 * is a typed DeferredWaitFailure; declare that schema in the deferred's error union.
 */
export const DeferredWait = Context.Reference<DurableCallbackConfig>(
  "alchemy/AWS/Lambda/DeferredWait",
  { defaultValue: () => ({}) },
);

/** A native callback deadline or externally failed wait. Declare in the deferred error schema. */
export class DeferredWaitFailure extends Schema.TaggedError<DeferredWaitFailure>()(
  "DeferredWaitFailure",
  {
    kind: Schema.Literals(["timed_out", "failed"]),
    message: Schema.String,
  },
) {}

const waitFailureOf = (defect: unknown): DeferredWaitFailure | undefined => {
  let current = defect;
  let message: string | undefined;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if (message === undefined && "message" in current && typeof current.message === "string")
      message = current.message;
    if ("errorType" in current) {
      if (current.errorType === "CallbackTimeoutError")
        return DeferredWaitFailure.make({
          kind: "timed_out",
          message: "The callback deadline expired",
        });
      if (current.errorType === "CallbackExternalError")
        return DeferredWaitFailure.make({
          kind: "failed",
          message: message ?? "The callback was failed externally",
        });
    }
    current = "cause" in current ? current.cause : undefined;
  }
};

/**
 * Annotate an Activity with a Lambda-native retry policy. The SDK checkpoints
 * failed attempts and backoff; typed failures are decoded after exhaustion.
 * Effect's Activity.retry is an outer Effect combinator and does not expose its
 * policy to WorkflowEngine, so use this annotation for SDK-managed retries.
 */
export interface ActivityRetryPolicy extends DurableRetryPolicy {
  /** Retry only typed failures accepted by this predicate. Receives the decoded Activity error. */
  readonly while?: (error: unknown) => boolean;
}

export const ActivityRetry = Context.Reference<ActivityRetryPolicy | undefined>(
  "alchemy/AWS/Lambda/ActivityRetry",
  { defaultValue: () => undefined },
);

const ACTIVITY_FAILURE = "alchemy/ActivityFailure";
const DEFERRED_FAILURE = "alchemy/DeferredFailure";
const failureText = (error: unknown, name: string): string | undefined => {
  let node = error;
  for (let depth = 0; depth < 8 && typeof node === "object" && node !== null; depth++) {
    if (
      "message" in node &&
      typeof node.message === "string" &&
      node.message.startsWith(`${name}:`)
    )
      return node.message.slice(name.length + 1);
    if (
      "name" in node &&
      node.name === name &&
      "message" in node &&
      typeof node.message === "string"
    )
      return node.message;
    node = "cause" in node ? node.cause : undefined;
  }
  return undefined;
};

const memo = <A>(
  run: CurrentRun["Service"],
  key: string,
  effect: Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    let cached = run.results.get(key);
    if (!cached) {
      cached = yield* Effect.cached(effect);
      run.results.set(key, cached);
    }
    return yield* cached;
  });

// ---------------------------------------------------------------- callers

/** A workflow host routed through an independently owned Lambda alias. */
export interface WorkflowFunctionTarget<
  Host extends WorkflowFunctionClass<any, any> = WorkflowFunctionClass<any, any>,
> {
  readonly host: Host;
  /** Alias that invokes this host. The engine does not manage its lifecycle. */
  readonly alias: Alias;
}

type EngineHost = WorkflowFunctionClass<any, any> | WorkflowFunctionTarget;
type HostedBy<Host> =
  Host extends WorkflowFunctionTarget<infer H>
    ? HostedBy<H>
    : Host extends WorkflowFunctionClass<any, infer W>
      ? WorkflowNames<W>
      : never;

/**
 * Run workflows hosted by {@link WorkflowFunction | AWS.Lambda.WorkflowFunction}s
 * from another Lambda function: a `WorkflowEngine` that starts, reads,
 * signals and interrupts each workflow's runs on the function that hosts it.
 *
 * Provide it to the calling function, and resolve each workflow's client with
 * `Workflows.RunWorkflow` during init. It grants the caller the IAM it needs
 * on each host. Running a workflow none of the hosts list is a type error.
 *
 * ### Running workflows from another function
 * **Example:** An API that starts orders
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as Layer from "effect/Layer";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { OrderWorkflows } from "./OrderWorkflows.ts";
 * import { PlaceOrder } from "./orders.ts";
 *
 * export class Api extends AWS.Lambda.Function<Api>()("Api") {}
 *
 * export default Api.make(
 *   { main: import.meta.url, functionUrl: true },
 *   Effect.gen(function* () {
 *     const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* placeOrder.start({ orderId: "o-1" });
 *         return HttpServerResponse.text(run.executionId);
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.Lambda.DurableFunctionEngine(OrderWorkflows))),
 * );
 * ```
 *
 * **Example:** Workflows across several functions
 * ```typescript
 * Effect.provide(AWS.Lambda.DurableFunctionEngine(OrderWorkflows, BillingWorkflows))
 * ```
 *
 * **Example:** A separately managed alias
 * ```typescript
 * const fn = yield* OrderWorkflows;
 * const version = yield* AWS.Lambda.Version("OrdersVersion", { function: fn });
 * const alias = yield* AWS.Lambda.Alias("OrdersLive", { version, aliasName: "live" });
 * const engine = AWS.Lambda.DurableFunctionEngine({ host: OrderWorkflows, alias });
 * ```
 *
 * The alias must belong to the supplied host. Starts invoke its ARN; lookups
 * search the host function across versions so runs remain reachable after the
 * alias moves. Their permissions are scoped to the alias and function respectively.
 * Execution and callback APIs use the execution ARN and callback id returned by
 * that target; their IAM permissions remain account-wide.
 * Omitting the target preserves the host's Function-owned alias or `$LATEST`.
 * AWS authority and transport are retained at initialization; logs, annotations
 * and tracing use the caller's context for each operation.
 *
 * @layer
 * @provides WorkflowEngine
 * @product Lambda
 */
/* oxlint-disable effecttsgo/unsafe-effect-type-assertion -- host init supplies runtime context for bound outputs */
export const DurableFunctionEngine = <const Hosts extends ReadonlyArray<EngineHost>>(
  ...hosts: Hosts
): Layer.Layer<
  WorkflowEngine.WorkflowEngine | ImplementedEach<HostedBy<Hosts[number]>>,
  never,
  LambdaServices | Function["Providers"]
> =>
  Layer.merge(
    Layer.effect(
      WorkflowEngine.WorkflowEngine,
      Effect.gen(function* () {
        const bind = yield* AWSBindings.Bind;
        const context = yield* Effect.context<LambdaServices>().pipe(
          Effect.map(AWSBindings.operationContext),
        );
        const routes = new Map<string, Calls>();
        for (const entry of hosts) {
          const host = "host" in entry ? entry.host : entry;
          const alias = "host" in entry ? entry.alias : undefined;
          const fn = yield* host;
          if (!globalThis.__ALCHEMY_RUNTIME__) {
            yield* bind`AWS.Lambda.DurableFunctionEngine(${fn})`({
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["lambda:ListDurableExecutionsByFunction"],
                  Resource: [fn.functionArn],
                },
                {
                  Effect: "Allow",
                  Action: ["lambda:InvokeFunction"],
                  Resource: alias
                    ? [alias.aliasArn]
                    : [fn.functionArn, Output.interpolate`${fn.functionArn}:*`],
                },
                // Durable execution ARNs aren't function ARNs, so reading and
                // signalling runs is granted account-wide, as the host's own is.
                {
                  Effect: "Allow",
                  Action: [
                    "lambda:GetDurableExecution",
                    "lambda:GetDurableExecutionHistory",
                    "lambda:StopDurableExecution",
                    "lambda:SendDurableExecutionCallbackSuccess",
                    "lambda:SendDurableExecutionCallbackFailure",
                  ],
                  Resource: ["*"],
                },
              ],
            });
          }
          const functionName = alias
            ? yield* alias.functionName.bind(`${fn.LogicalId}.engineFunctionName`)
            : yield* fn.functionName;
          // Runs start on the host's alias when it sets one.
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the host provides RuntimeContext at runtime
          const qualifier = yield* (alias ? alias.aliasName : qualifierOf(fn)).bind(
            `${fn.LogicalId}.qualifier`,
          ) as Effect.Effect<Effect.Effect<string>>;
          const calls = makeCalls(
            (effect) => effect.pipe(Effect.provide(context)),
            functionName,
            qualifier,
          );
          for (const workflow of host.workflows) routes.set(workflow._tag, calls);
        }
        return makeEngine({
          route: (workflowName) => {
            const calls = routes.get(workflowName);
            return calls
              ? Effect.succeed(calls)
              : Effect.die(new Error(`No WorkflowFunction hosts workflow ${workflowName}`));
          },
          // Workflows run on their hosts; nothing registers here.
          register: () => undefined,
        });
      }),
    ),
    implemented(
      hosts.flatMap((entry) =>
        ("host" in entry ? entry.host : entry).workflows.map((workflow) => workflow._tag),
      ),
    ) as Layer.Layer<ImplementedEach<HostedBy<Hosts[number]>>>,
  ) as Layer.Layer<
    WorkflowEngine.WorkflowEngine | ImplementedEach<HostedBy<Hosts[number]>>,
    never,
    LambdaServices | Function["Providers"]
  >;

/* oxlint-enable effecttsgo/unsafe-effect-type-assertion */

// ---------------------------------------------------------------- hosting

/** What a durable function running workflows is started with. */
interface WorkflowInvocation {
  /** The workflow's tag. */
  readonly workflow: string;
  readonly executionId: string;
  /** The payload, encoded. */
  readonly payload: unknown;
}

/** The services the engines call Lambda with. */
type LambdaServices = Credentials | HttpClient.HttpClient;

/**
 * The durable function body that runs the given workflows: each invocation is
 * one run of one workflow. Child workflows start in the same function.
 */
export const makeWorkflowRunner = <ROut, E, RIn>(
  workflows: Layer.Layer<ROut, E, RIn>,
): Effect.Effect<
  DurableFunctionImpl<WorkflowInvocation, string>,
  E,
  Exclude<RIn, WorkflowEngine.WorkflowEngine> | LambdaServices
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<LambdaServices>().pipe(
      Effect.map(AWSBindings.operationContext),
    );
    const functionName = yield* Effect.sync(() => process.env.AWS_LAMBDA_FUNCTION_NAME);
    // Child workflows start on the version this function is running.
    const version = yield* Effect.sync(() => process.env.AWS_LAMBDA_FUNCTION_VERSION ?? "$LATEST");
    const handlers = new Map<string, Registration>();
    const calls = makeCalls(
      (effect) => effect.pipe(Effect.provide(context)),
      functionName
        ? Effect.succeed(functionName)
        : Effect.die(new Error("AWS_LAMBDA_FUNCTION_NAME is not set")),
      Effect.succeed(version),
    );
    const engine = makeEngine({
      route: (workflowName) =>
        handlers.has(workflowName)
          ? Effect.succeed(calls)
          : Effect.die(new Error(`Workflow ${workflowName} is not hosted by this function`)),
      register: (workflow, execute) => handlers.set(workflow._tag, { workflow, execute }),
    });
    // Workflows register for the life of the function instance.
    yield* Layer.buildWithScope(
      workflows.pipe(Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, engine))),
      yield* Scope.make(),
    );

    return (invocation: WorkflowInvocation) =>
      Effect.gen(function* () {
        const registration = handlers.get(invocation.workflow);
        if (!registration) {
          return yield* Effect.die(new Error(`Workflow ${invocation.workflow} is not hosted here`));
        }
        const durable = yield* DurableStep;
        const { workflow, execute } = registration;
        const payload = yield* Schema.decodeEffect(payloadCodec(workflow))(invocation.payload).pipe(
          Effect.orDie,
        );
        const instance = WorkflowEngine.WorkflowInstance.initial(workflow, invocation.executionId);
        const result = yield* execute(payload as object, invocation.executionId).pipe(
          Workflow.intoResult,
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(WorkflowEngine.WorkflowInstance, instance),
              Layer.succeed(WorkflowEngine.WorkflowEngine, engine),
              Layer.succeed(CurrentRun, {
                durable,
                clocks: new Map(),
                results: new Map(),
                instance,
                waited: new Map(),
              }),
            ),
          ),
        );
        // Every wait blocks inside the durable execution, so a run always finishes.
        if (result._tag === "Suspended") {
          return yield* Effect.die(new Error(`Workflow ${workflow._tag} suspended unexpectedly`));
        }
        return yield* encodeResult(workflow, result.exit);
      });
  }) as Effect.Effect<
    DurableFunctionImpl<WorkflowInvocation, string>,
    E,
    Exclude<RIn, WorkflowEngine.WorkflowEngine> | LambdaServices
  >;

// ---------------------------------------------------------------- the engine

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

interface Registration {
  readonly workflow: Workflow.AnyWithProps;
  readonly execute: Execute;
}

/** The run in progress: its durable context, and the clocks it has scheduled. */
class CurrentRun extends Context.Service<
  CurrentRun,
  {
    readonly durable: DurableStep["Service"];
    readonly clocks: Map<string, Duration.Duration>;
    readonly results: Map<string, Effect.Effect<any>>;
    readonly instance: WorkflowEngine.WorkflowInstance["Service"];
    /** Waits run outside the activity that reached them, by deferred name. */
    readonly waited: Map<string, string>;
    /** Inside an activity's step, which can't wait: the wait it reached. */
    readonly step?: { pending?: Pending };
  }
>()("alchemy/AWS/Lambda/DurableWorkflows/CurrentRun") {}

/** A wait an activity reached inside its step, recorded so a replay repeats it. */
interface Pending {
  readonly name: string;
  readonly clockMillis?: number;
  readonly config?: DurableCallbackConfig;
}

/** An interrupt fails the callback a run waits on: the run is interrupted there. */
const interruptible = <A>(run: CurrentRun["Service"], wait: Effect.Effect<A>) =>
  wait.pipe(
    Effect.catchDefect((defect) =>
      isInterrupt(defect)
        ? Effect.sync(() => {
            run.instance.interrupted = true;
            run.instance.suspended = false;
          }).pipe(Effect.andThen(Effect.interrupt))
        : Effect.die(defect),
    ),
  );

/** Wait for a deferred: a clock's sleep is a durable wait, a signal a callback. Its exit, encoded. */
const waitFor = (run: CurrentRun["Service"], pending: Pending) =>
  Effect.gen(function* () {
    if (pending.clockMillis !== undefined) {
      yield* run.durable.wait(
        pending.name,
        Duration.max(Duration.millis(pending.clockMillis), Duration.seconds(1)),
      );
      return yield* encodeExit(Exit.void);
    }
    const text = yield* interruptible(
      run,
      run.durable
        .waitForCallback<string>({
          ...pending.config,
          name: pending.name,
          submitter: () => Effect.void,
        })
        .pipe(
          Effect.catchDefect((defect) => {
            if (isInterrupt(defect)) return Effect.die(defect);
            const encoded = failureText(defect, DEFERRED_FAILURE);
            if (encoded !== undefined) return Effect.succeed(encoded);
            const failure = waitFailureOf(defect);
            return failure === undefined
              ? Effect.die(defect)
              : Schema.encodeEffect(DeferredWaitFailure)(failure).pipe(
                  Effect.orDie,
                  Effect.flatMap((encoded) => encodeExit(Exit.fail(encoded))),
                );
          }),
        ),
    );
    const encoded = typeof text === "string" ? text : JSON.stringify(text);
    const exit = yield* decodeExit(encoded);
    if (Exit.isFailure(exit)) {
      const defect = exit.cause.reasons.find(Cause.isDieReason);
      const failure = defect === undefined ? undefined : waitFailureOf(defect.defect);
      if (failure !== undefined)
        return yield* Schema.encodeEffect(DeferredWaitFailure)(failure).pipe(
          Effect.orDie,
          Effect.flatMap((error) => encodeExit(Exit.fail(error))),
        );
    }
    return encoded;
  });

const currentRun = (operation: string) =>
  Effect.flatMap(Effect.serviceOption(CurrentRun), (run) =>
    Option.isSome(run)
      ? Effect.succeed(run.value)
      : Effect.die(new Error(`WorkflowFunction: ${operation} only runs inside a workflow run`)),
  );

/** A callback failed with this type interrupts the run waiting on it. */
const INTERRUPT = "alchemy/WorkflowInterrupted";

/**
 * What an activity's step records when the activity suspends: on a failure,
 * or on a wait it reached inside its step, followed by that wait as JSON.
 */
const SUSPENDED = "alchemy-suspended:";

/** The callback a run suspended on a failure waits on, which `resume` completes. */
const isSuspension = (name: string) => name.includes("/suspended-");

/** The SDK's callback error arrives wrapped, with the type in its cause chain. */
const isInterrupt = (defect: unknown) => {
  let node = defect;
  for (let depth = 0; node !== null && typeof node === "object" && depth < 5; depth++) {
    const error = node as {
      readonly name?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
    };
    if (
      error.name === INTERRUPT ||
      (typeof error.message === "string" && error.message.includes(INTERRUPT))
    ) {
      return true;
    }
    node = error.cause;
  }
  return false;
};

/** Lambda's calls for one host function. */
interface Calls {
  readonly start: (executionName: string, invocation: WorkflowInvocation) => Effect.Effect<string>;
  readonly target: Effect.Effect<string>;
  readonly find: (executionName: string) => Effect.Effect<string | undefined>;
  readonly get: (
    executionArn: string,
  ) => Effect.Effect<{ readonly status: string; readonly result: string | undefined }>;
  readonly history: (executionArn: string) => Effect.Effect<ReadonlyArray<Lambda.Event>>;
  readonly historyPage: (
    executionArn: string,
    marker?: string,
  ) => Effect.Effect<Lambda.GetDurableExecutionHistoryResponse>;
  readonly stop: (executionArn: string) => Effect.Effect<void>;
  readonly succeed: (callbackId: string, result: string) => Effect.Effect<void>;
  readonly fail: (callbackId: string, errorType: string, message?: string) => Effect.Effect<void>;
}

const unwrap = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

const makeCalls = (
  provide: <A, E>(effect: Effect.Effect<A, E, LambdaServices>) => Effect.Effect<A, E>,
  functionName: Effect.Effect<string>,
  qualifier: Effect.Effect<string>,
): Calls => {
  const run = <A, E>(effect: Effect.Effect<A, E, LambdaServices>) =>
    provide(effect).pipe(Effect.orDie);
  const find = (FunctionName: string, executionName: string) =>
    // A qualifier hides executions pinned to versions an alias no longer serves.
    Lambda.listDurableExecutionsByFunction
      .items({ FunctionName, DurableExecutionName: executionName })
      .pipe(
        Stream.runCollect,
        Effect.flatMap((executions) => {
          const arns = [
            ...new Set(
              [...executions]
                .filter((execution) => execution.DurableExecutionName === executionName)
                .map((execution) => execution.DurableExecutionArn),
            ),
          ];
          return arns.length > 1
            ? Effect.fail(
                new AmbiguousDurableExecutionIdentity({
                  functionName: FunctionName,
                  executionName,
                  executionArns: arns,
                }),
              )
            : Effect.succeed(arns[0]);
        }),
      );
  return {
    target: Effect.map(
      Effect.all([functionName, qualifier]),
      ([name, version]) => `${name}:${version}`,
    ),
    start: (executionName, invocation) =>
      Effect.flatMap(Effect.all([functionName, qualifier]), ([FunctionName, Qualifier]) =>
        run(
          Lambda.invoke({
            FunctionName,
            Qualifier,
            InvocationType: "Event",
            DurableExecutionName: executionName,
            Payload: JSON.stringify(invocation),
          }).pipe(
            Effect.catchTag("DurableExecutionAlreadyStartedException", () =>
              find(FunctionName, executionName).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("100 millis"),
                  until: (arn) => arn !== undefined,
                  times: 2,
                }),
                Effect.flatMap((arn) =>
                  arn === undefined
                    ? Effect.fail(
                        new DurableExecutionIdentityUnavailable({
                          functionName: FunctionName,
                          executionName,
                        }),
                      )
                    : Effect.succeed({ DurableExecutionArn: arn }),
                ),
              ),
            ),
            Effect.flatMap((result) =>
              result.DurableExecutionArn
                ? Effect.succeed(result.DurableExecutionArn)
                : Effect.die(new Error("Lambda Invoke did not return DurableExecutionArn")),
            ),
          ),
        ),
      ),
    find: (executionName) =>
      Effect.flatMap(functionName, (FunctionName) => run(find(FunctionName, executionName))),
    get: (executionArn) =>
      run(
        Lambda.getDurableExecution({ DurableExecutionArn: executionArn }).pipe(
          Effect.map((execution) => ({
            status: execution.Status,
            result: unwrap(execution.Result),
          })),
        ),
      ),
    history: (executionArn) =>
      run(
        Lambda.getDurableExecutionHistory.items({ DurableExecutionArn: executionArn }).pipe(
          Stream.runCollect,
          Effect.map((events) => [...events]),
        ),
      ),
    historyPage: (executionArn, marker) =>
      run(
        Lambda.getDurableExecutionHistory({
          DurableExecutionArn: executionArn,
          ReverseOrder: true,
          MaxItems: 20,
          Marker: marker,
        }),
      ),
    stop: (executionArn) =>
      run(Lambda.stopDurableExecution({ DurableExecutionArn: executionArn }).pipe(Effect.asVoid)),
    succeed: (callbackId, result) =>
      run(
        Lambda.sendDurableExecutionCallbackSuccess({ CallbackId: callbackId, Result: result }).pipe(
          Effect.asVoid,
        ),
      ),
    fail: (callbackId, errorType, message = errorType) =>
      run(
        Lambda.sendDurableExecutionCallbackFailure({
          CallbackId: callbackId,
          Error: { ErrorType: errorType, ErrorMessage: message },
        }).pipe(Effect.asVoid),
      ),
  };
};

/**
 * Build the runtime engine without deploy-time host binding. AWS authority and
 * transport are retained; telemetry comes from the caller of each operation.
 * @internal
 */
export const makeWorkflowEngine = (functionName: string, qualifier: string) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<LambdaServices>().pipe(
      Effect.map(AWSBindings.operationContext),
    );
    const calls = makeCalls(
      (effect) => Effect.provide(effect, context),
      Effect.succeed(functionName),
      Effect.succeed(qualifier),
    );
    return makeEngine({ route: () => Effect.succeed(calls), register: () => undefined });
  });

/**
 * A durable execution's name: the workflow and execution id, within Lambda's
 * limit of 64 letters, digits, `-` and `_`.
 */
/** @internal */
export const executionNameOf = (workflowName: string, executionId: string) => {
  const name = `${workflowName}-${executionId}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (name.length <= 64) return name;
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `${name.slice(0, 55)}-${hash.toString(16).padStart(8, "0")}`;
};

/**
 * A run's callbacks: the ones it is waiting on, started and not yet completed,
 * and the names of the ones already completed. A callback's name is on the
 * `waitForCallback` context it was started in, its parent.
 */
const callbacksOf = (events: ReadonlyArray<Lambda.Event>) => {
  const names = new Map<string, string>();
  const started = new Map<string, { readonly name: string; readonly callbackId: string }>();
  const completed = new Set<string>();
  for (const event of events) {
    if (event.SubType === "WaitForCallback" && event.Id && event.Name) {
      names.set(event.Id, event.Name);
    }
    if (event.CallbackStartedDetails && event.Id) {
      started.set(event.Id, {
        name: (event.ParentId && names.get(event.ParentId)) ?? event.Name ?? "",
        callbackId: event.CallbackStartedDetails.CallbackId,
      });
    }
    if (
      event.Id &&
      (event.CallbackSucceededDetails ||
        event.CallbackFailedDetails ||
        event.CallbackTimedOutDetails)
    ) {
      const callback = started.get(event.Id);
      if (callback) completed.add(callback.name);
      started.delete(event.Id);
    }
  }
  return { pending: [...started.values()], completed };
};

const pendingCallbacks = (events: ReadonlyArray<Lambda.Event>) => callbacksOf(events).pending;

/** Whether a run is in a durable wait: a sleep, or a parent checking on its child. */
const sleeping = (events: ReadonlyArray<Lambda.Event>) => {
  const waits = new Set<string>();
  for (const event of events) {
    if (!event.Id) continue;
    if (event.WaitStartedDetails) waits.add(event.Id);
    if (event.WaitSucceededDetails || event.WaitCancelledDetails) waits.delete(event.Id);
  }
  return waits.size > 0;
};

/** Whether a run has finished, so there's nothing left to signal or interrupt. */
const finished = (calls: Calls, executionArn: string) =>
  Effect.map(calls.get(executionArn), ({ status }) => status !== "RUNNING");

/**
 * Scan newest first, carrying terminal ids and context names across page boundaries.
 * The SDK's callback is unnamed; its enclosing WaitForCallback context owns the
 * deferred name. Terminal ids exclude their starts even across page boundaries.
 */
const findCallback = (calls: Calls, executionArn: string, deferredName: string) =>
  Effect.gen(function* () {
    const closed = new Set<string>();
    const names = new Map<string, string>();
    const starts: Array<{
      id: string;
      callbackId: string;
      parentId: string | undefined;
      name: string | undefined;
    }> = [];
    let marker: string | undefined;
    const markers = new Set<string>();
    do {
      const page = yield* calls.historyPage(executionArn, marker);
      for (const event of page.Events) {
        if (!event.Id) continue;
        if (event.SubType === "WaitForCallback" && event.Name) names.set(event.Id, event.Name);
        if (
          event.CallbackSucceededDetails ||
          event.CallbackFailedDetails ||
          event.CallbackTimedOutDetails
        )
          closed.add(event.Id);
        if (event.CallbackStartedDetails)
          starts.push({
            id: event.Id,
            callbackId: event.CallbackStartedDetails.CallbackId,
            parentId: event.ParentId,
            name: event.Name,
          });
      }
      let unresolved = false;
      for (const start of starts) {
        if (closed.has(start.id)) continue;
        const name = start.parentId ? names.get(start.parentId) : start.name;
        if (name === undefined) {
          unresolved = true;
          continue;
        }
        if (name === deferredName && !unresolved) return start.callbackId;
      }
      marker = page.NextMarker;
      if (marker !== undefined) {
        if (markers.has(marker))
          return yield* Effect.die(
            new Error(`Lambda returned a repeated history marker for ${executionArn}`),
          );
        markers.add(marker);
      }
    } while (marker !== undefined);
    return undefined;
  });

/** Read a run's result from Lambda: undefined while it runs. */
const readResult = (calls: Calls, workflow: Workflow.AnyWithProps, executionArn: string) =>
  Effect.gen(function* () {
    const { status, result } = yield* calls.get(executionArn);
    switch (status) {
      case "RUNNING":
        return undefined;
      case "SUCCEEDED":
        return yield* decodeResult(workflow, JSON.parse(result ?? "null") as string);
      case "STOPPED":
        return new Workflow.Complete({ exit: Exit.interrupt() });
      default:
        return new Workflow.Complete({
          exit: Exit.die(new Error(`Workflow execution ${executionArn} ended ${status}`)),
        });
    }
  });

const makeEngine = (options: {
  /** The calls for the function that hosts a workflow. */
  readonly route: (workflowName: string) => Effect.Effect<Calls>;
  readonly register: (workflow: Workflow.AnyWithProps, execute: Execute) => void;
}): WorkflowEngine.WorkflowEngine["Service"] => {
  const { route } = options;
  const find = (calls: Calls, name: string) =>
    Effect.flatMap(ExecutionReference, (arn) =>
      arn === undefined ? calls.find(name) : Effect.succeed(arn),
    );
  const engine: WorkflowEngine.WorkflowEngine["Service"] = WorkflowEngine.makeUnsafe({
    register: (workflow, execute) =>
      Effect.sync(() => options.register(workflow as Workflow.AnyWithProps, execute)),

    execute: (workflow, opts) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
        const executionName = executionNameOf(workflow._tag, opts.executionId);
        const payload = yield* Schema.encodeEffect(payloadCodec(workflow as Workflow.AnyWithProps))(
          opts.payload,
        ).pipe(Effect.orDie);
        const invocation = { workflow: workflow._tag, executionId: opts.executionId, payload };
        const run = yield* Effect.serviceOption(CurrentRun);
        if (Option.isSome(run) && !opts.discard) {
          const text = yield* memo(
            run.value,
            `child/${executionName}`,
            Effect.flatMap(calls.target, (target) =>
              run.value.durable.invoke<string>(`child/${executionName}`, target, invocation),
            ),
          );
          return yield* decodeResult(workflow as Workflow.AnyWithProps, text);
        }
        const arn = yield* calls.start(executionName, invocation);
        const receipt = yield* Effect.serviceOption(StartReceipt);
        if (Option.isSome(receipt)) receipt.value.record(arn);
        if (opts.discard) return undefined;
        return (
          (yield* readResult(calls, workflow as Workflow.AnyWithProps, arn)) ??
          Workflow.Suspended.make({})
        );
      }) as Effect.Effect<any>,

    poll: (workflow, executionId) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
        const arn = yield* find(calls, executionNameOf(workflow._tag, executionId));
        if (!arn) return Option.none();
        const result = yield* readResult(calls, workflow as Workflow.AnyWithProps, arn);
        return Option.some(result ?? Workflow.Suspended.make({}));
      }),

    // A run waiting on a signal is woken with an interrupt, so its
    // compensations run. A sleeping run is stopped. A run still working,
    // or not listed yet, gets a while to reach one or the other.
    interrupt: (workflow, executionId) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
        const executionName = executionNameOf(workflow._tag, executionId);
        const target = yield* Effect.gen(function* () {
          const arn = yield* find(calls, executionName);
          if (!arn) return yield* Effect.fail({ arn } as const);
          const events = yield* calls.history(arn);
          const pending = pendingCallbacks(events);
          if (pending.length > 0) return { arn, pending, stop: false };
          if (sleeping(events)) return { arn, pending, stop: true };
          if (yield* finished(calls, arn)) return { arn, pending, stop: false };
          return yield* Effect.fail({ arn } as const);
        }).pipe(
          Effect.retry({
            schedule: Schedule.min([
              Schedule.exponential("200 millis"),
              Schedule.spaced("2 seconds"),
            ]),
            times: 25,
          }),
          // Still working after all that: it can only be stopped.
          Effect.catch(({ arn }) => Effect.succeed({ arn, pending: [], stop: true })),
        );
        if (!target.arn) return;
        if (target.stop) return yield* calls.stop(target.arn);
        yield* Effect.forEach(
          target.pending,
          (callback) => calls.fail(callback.callbackId, INTERRUPT),
          {
            discard: true,
          },
        );
      }),

    interruptUnsafe: (workflow, executionId) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
        const arn = yield* find(calls, executionNameOf(workflow._tag, executionId));
        if (arn) yield* calls.stop(arn);
      }),

    // Only a run suspended on a failure waits to be resumed: complete the
    // callback it waits on.
    resume: (workflow, executionId) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
        const arn = yield* calls.find(executionNameOf(workflow._tag, executionId));
        if (!arn) return;
        const suspended = pendingCallbacks(yield* calls.history(arn)).filter((callback) =>
          isSuspension(callback.name),
        );
        yield* Effect.forEach(suspended, (callback) => calls.succeed(callback.callbackId, "{}"), {
          discard: true,
        });
      }),

    /* oxlint-disable effecttsgo/unsafe-effect-type-assertion -- the captured Activity caller context and engine-owned services are restored for the SDK callback */
    activityExecute: (activity, attempt) =>
      Effect.gen(function* () {
        const run = yield* currentRun("activity execution");
        // The SDK callback runs on a fresh fiber; capture services and telemetry
        // here so providers around the Activity take precedence over invocation init.
        const context = yield* Effect.context<never>();
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const activityInstance = WorkflowEngine.WorkflowInstance.initial(
          instance.workflow,
          instance.executionId,
        );
        activityInstance.interrupted = instance.interrupted;
        const retry = Context.get(activity.annotations, ActivityRetry);
        for (let generation = 0; ; generation++) {
          const step: { pending?: Pending } = {};
          const stepName =
            generation === 0
              ? `${activity.name}/${attempt}`
              : `${activity.name}/${attempt}/resumed-${generation}`;
          const text = yield* memo(
            run,
            `activity/${stepName}`,
            run.durable
              .step({
                name: stepName,
                ...(retry
                  ? {
                      retry,
                      retryWhen: (error: Error) =>
                        failureText(error, ACTIVITY_FAILURE) !== undefined,
                    }
                  : { retry: { limit: 0 } }),
                effect: Effect.flatMap(DurableStepAttempt, (nativeAttempt) =>
                  activity.executeEncoded.pipe(
                    Effect.provideService(Activity.CurrentAttempt, attempt + nativeAttempt - 1),
                    Workflow.intoResult,
                    Effect.flatMap((result) =>
                      result._tag === "Complete"
                        ? Effect.flatMap(encodeExit(result.exit), (text) =>
                            retry &&
                            Exit.isFailure(result.exit) &&
                            Cause.hasFails(result.exit.cause) &&
                            !Cause.hasInterrupts(result.exit.cause)
                              ? Effect.gen(function* () {
                                  const failure = Exit.isFailure(result.exit)
                                    ? Cause.findErrorOption(result.exit.cause)
                                    : Option.none();
                                  if (retry.while && Option.isSome(failure)) {
                                    if (
                                      !("errorSchema" in activity) ||
                                      !Schema.isSchema(activity.errorSchema)
                                    ) {
                                      return yield* Effect.die(
                                        new Error(
                                          "Activity retry predicate requires an error schema",
                                        ),
                                      );
                                    }
                                    const decoded = yield* Schema.decodeUnknownEffect(
                                      Schema.toCodecJson(activity.errorSchema),
                                    )(failure.value).pipe(Effect.orDie);
                                    if (!retry.while(decoded)) return text;
                                  }
                                  return yield* Effect.die(
                                    Object.assign(new Error(`${ACTIVITY_FAILURE}:${text}`), {
                                      name: ACTIVITY_FAILURE,
                                    }),
                                  );
                                })
                              : Effect.succeed(text),
                          )
                        : Effect.succeed(`${SUSPENDED}${JSON.stringify(step.pending ?? null)}`),
                    ),
                    // Preserve the Activity caller, with engine-owned per-attempt services.
                    Effect.provide(
                      Layer.succeedContext(
                        context.pipe(
                          Context.add(DurableStepAttempt, nativeAttempt),
                          Context.add(CurrentRun, { ...run, step }),
                          Context.add(WorkflowEngine.WorkflowEngine, engine),
                          Context.add(WorkflowEngine.WorkflowInstance, activityInstance),
                          Context.add(
                            CurrentActivity,
                            makeCurrentActivity(
                              instance.workflow._tag,
                              instance.executionId,
                              activity.name,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ) as Effect.Effect<string>,
              })
              .pipe(
                Effect.catchDefect((error) => {
                  const text = failureText(error, ACTIVITY_FAILURE);
                  return text === undefined ? Effect.die(error) : Effect.succeed(text);
                }),
              ),
          );
          if (!text.startsWith(SUSPENDED))
            return new Workflow.Complete({ exit: yield* decodeExit(text) });
          const pending = JSON.parse(text.slice(SUSPENDED.length)) as Pending | null;
          if (pending) {
            run.waited.set(pending.name, yield* waitFor(run, pending));
            continue;
          }
          yield* interruptible(
            run,
            run.durable.waitForCallback<string>({
              name: `${activity.name}/${attempt}/suspended-${generation}`,
              submitter: () => Effect.void,
            }),
          );
        }
      }),

    /* oxlint-enable effecttsgo/unsafe-effect-type-assertion */

    // A clock's sleep is a durable wait; a signal is a callback to wait for.
    deferredResult: (deferred) =>
      Effect.gen(function* () {
        const run = yield* currentRun("DurableDeferred reads");
        // A race asks for its recorded winner before it runs. Lambda replays
        // operations in order, so a winner can't be looked up first.
        if (deferred.name.startsWith("raceAll/")) {
          return yield* Effect.die(
            new Error(
              "Activity.raceAll and DurableDeferred.raceAll aren't supported on Lambda durable functions: a step's result can't be looked up before the step runs.",
            ),
          );
        }
        const waited = run.waited.get(deferred.name);
        if (waited !== undefined) return Option.some(yield* decodeExit(waited));
        const duration = run.clocks.get(deferred.name);
        const pending: Pending = {
          name: deferred.name,
          config: yield* DeferredWait,
          ...(duration === undefined ? {} : { clockMillis: Duration.toMillis(duration) }),
        };
        // Inside a step: the activity suspends, and the wait runs after it.
        if (run.step) {
          run.step.pending = pending;
          return Option.none();
        }
        return Option.some(yield* decodeExit(yield* waitFor(run, pending)));
      }),

    deferredDone: (opts) =>
      Effect.gen(function* () {
        const calls = yield* route(opts.workflowName);
        const arn = yield* find(calls, executionNameOf(opts.workflowName, opts.executionId));
        const callbackId =
          arn === undefined ? undefined : yield* findCallback(calls, arn, opts.deferredName);
        if (callbackId === undefined)
          return yield* Effect.die(
            new NotYetWaiting({
              workflowName: opts.workflowName,
              executionId: opts.executionId,
              deferredName: opts.deferredName,
            }),
          );
        const text = yield* encodeExit(opts.exit);
        if (Exit.isFailure(opts.exit))
          yield* calls.fail(callbackId, DEFERRED_FAILURE, `${DEFERRED_FAILURE}:${text}`);
        else yield* calls.succeed(callbackId, text);
      }),

    scheduleClock: (_workflow, opts) =>
      Effect.flatMap(currentRun("DurableClock scheduling"), (run) =>
        Effect.sync(() => void run.clocks.set(opts.clock.deferred.name, opts.clock.duration)),
      ),
  });
  return engine;
};
