import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class FrameworkServerError extends Data.TaggedError("FrameworkServerError")<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const frontendCoreModule = "@alchemy.run/frontend-frameworks/core";

/** Keep the optional build and dev peer outside cold provider bundles. */
export const importFrontendCore = (framework = frontendCoreModule) =>
  Effect.tryPromise({
    try: () =>
      import(frontendCoreModule) as Promise<typeof import("@alchemy.run/frontend-frameworks/core")>,
    catch: (cause) =>
      new FrameworkServerError({
        framework,
        message:
          `Failed to import "${frontendCoreModule}". ` +
          "Install @alchemy.run/frontend-frameworks in your project to build or serve a website.",
        cause,
      }),
  });

export const loadFrontendCore = importFrontendCore().pipe(Effect.orDie);
