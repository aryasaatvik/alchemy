import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * When Lambda moves a zip function onto a new version of its managed runtime.
 *
 * - `"Auto"` (AWS's default): Lambda applies runtime patches on its own
 *   two-phase rollout.
 * - `"FunctionUpdate"`: Lambda applies the latest runtime version the next
 *   time the function's code or configuration is updated.
 * - `"Manual"`: the function stays on `runtimeVersionArn` until that value
 *   changes. Use it when the artifact depends on an exact Node build (for
 *   example a shipped V8 compile cache), and take runtime patches by bumping
 *   the ARN deliberately.
 *
 * The ARN of the version a function runs is printed on its `INIT_START` log
 * line (`Runtime Version ARN: ...`).
 */
export type RuntimeManagementConfig =
  | {
      updateRuntimeOn: "Auto" | "FunctionUpdate";
      runtimeVersionArn?: never;
    }
  | {
      updateRuntimeOn: "Manual";
      runtimeVersionArn: string;
    };

/** AWS's runtime management for a function that never configured one. */
export const DefaultRuntimeManagementConfig: RuntimeManagementConfig = {
  updateRuntimeOn: "Auto",
};

export const isSameRuntimeManagementConfig = (
  a: RuntimeManagementConfig,
  b: RuntimeManagementConfig,
): boolean =>
  a.updateRuntimeOn === b.updateRuntimeOn &&
  a.runtimeVersionArn === b.runtimeVersionArn;

/**
 * Whether Alchemy manages a function's runtime updates. A function that has
 * never set `runtimeManagementConfig` is left on whatever AWS applies (its
 * default is `"Auto"`) and costs no runtime-management API calls; removing
 * the prop from a function that set it returns the function to `"Auto"`.
 */
export const managesRuntime = (
  news: RuntimeManagementConfig | undefined,
  olds: RuntimeManagementConfig | undefined,
): boolean => news !== undefined || olds !== undefined;

/**
 * Read the unqualified function's runtime management config. Lambda reports
 * `RuntimeVersionArn` only in `"Manual"` mode.
 */
export const observeRuntimeManagementConfig = Effect.fn(function* (
  functionName: string,
) {
  const observed = yield* Lambda.getRuntimeManagementConfig({
    FunctionName: functionName,
  });
  switch (observed.UpdateRuntimeOn) {
    case "Manual": {
      if (observed.RuntimeVersionArn === undefined) {
        return yield* Effect.die(
          new Error(
            `Lambda reported Manual runtime updates for ${functionName} without a runtime version ARN`,
          ),
        );
      }
      return {
        updateRuntimeOn: "Manual" as const,
        runtimeVersionArn: observed.RuntimeVersionArn,
      };
    }
    case "Auto":
      return { updateRuntimeOn: "Auto" as const };
    case "FunctionUpdate":
      return { updateRuntimeOn: "FunctionUpdate" as const };
    case undefined:
      return DefaultRuntimeManagementConfig;
    default:
      return yield* Effect.die(
        new Error(
          `Lambda reported an unknown runtime update mode for ${functionName}: ${observed.UpdateRuntimeOn}`,
        ),
      );
  }
});

/**
 * Converge the unqualified function's runtime management config to
 * `desired` (`undefined` means AWS's default, `"Auto"`). Diffs against the
 * observed config so a converged deploy skips the write. Call it only while
 * the function is not mid-update; Lambda rejects the put with
 * `ResourceConflictException` during an update, which is retried.
 */
export const syncRuntimeManagementConfig = Effect.fn(function* ({
  functionName,
  desired = DefaultRuntimeManagementConfig,
}: {
  functionName: string;
  desired: RuntimeManagementConfig | undefined;
}) {
  const observed = yield* observeRuntimeManagementConfig(functionName);
  if (isSameRuntimeManagementConfig(observed, desired)) {
    return observed;
  }
  yield* Lambda.putRuntimeManagementConfig({
    FunctionName: functionName,
    UpdateRuntimeOn: desired.updateRuntimeOn,
    RuntimeVersionArn: desired.runtimeVersionArn,
  }).pipe(
    Effect.retry({
      while: (e) =>
        e._tag === "ResourceConflictException" ||
        e._tag === "TooManyRequestsException",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
  return desired;
});
