import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import { TestWorkflows } from "./host.ts";

export const liveAlias = Effect.gen(function* () {
  const fn = yield* TestWorkflows;
  const version = yield* Lambda.Version("WorkflowsVersion", { function: fn });
  return yield* Lambda.Alias("WorkflowsLive", { version, aliasName: "live" });
});
