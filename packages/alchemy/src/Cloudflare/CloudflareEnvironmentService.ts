import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { CloudflareResolvedCredentials } from "./Auth/AuthConfig.ts";

/** Account-only identity used by local and deployed application runtimes. */
export interface CloudflareRuntimeIdentity {
  readonly type: "runtime";
  readonly accountId: string;
  readonly source: { readonly type: "runtime" };
}

export type CloudflareEnvironmentShape =
  | CloudflareResolvedCredentials
  | CloudflareRuntimeIdentity;

export class CloudflareEnvironment extends Context.Service<
  CloudflareEnvironment,
  Effect.Effect<CloudflareEnvironmentShape>
>()("Cloudflare::CloudflareEnvironment") {
  readonly kind = "Environment" as const;
}
