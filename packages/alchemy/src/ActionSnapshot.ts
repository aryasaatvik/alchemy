import * as Effect from "effect/Effect";
import { hashInput } from "./Util/sha256.ts";

/** Values that determine whether an Action body must run. */
export interface ActionSnapshot {
  readonly input: unknown;
  readonly captures: Record<string, unknown>;
  readonly inputHash: string;
}

/**
 * Materialize the identity of one Action execution.
 *
 * Actions without captures retain the historical input-only hash so existing
 * persisted rows remain valid. Captured values extend the fingerprint because
 * the Action body can read them even when its explicit input is unchanged.
 */
export const makeActionSnapshot = Effect.fn("action.makeSnapshot")(function* (
  values: Omit<ActionSnapshot, "inputHash">,
) {
  const inputHash = yield* Object.keys(values.captures).length === 0
    ? hashInput(values.input)
    : hashInput({ input: values.input, captures: values.captures });
  return { ...values, inputHash } satisfies ActionSnapshot;
});
