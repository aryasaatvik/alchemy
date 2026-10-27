import * as Effect from "effect/Effect";
import { FrameworkServerError } from "./Server.ts";

const FRONTEND_CORE_MODULE = "@alchemy.run/frontend-frameworks/core";

/**
 * Loads `@alchemy.run/frontend-frameworks/core` when a website is built or
 * served. The package is an optional peer dependency, so provider entrypoints
 * that re-export their `Website` namespace (e.g. `@alchemy.run/prisma`) must not
 * import it statically — that would break every consumer that never deploys a
 * website and so never installed it. The import goes through a binding rather
 * than a string literal so bundlers leave it to runtime as well.
 */
export const loadFrontendCore = Effect.tryPromise({
  try: () =>
    import(FRONTEND_CORE_MODULE) as Promise<typeof import("@alchemy.run/frontend-frameworks/core")>,
  catch: (cause) =>
    new FrameworkServerError({
      framework: FRONTEND_CORE_MODULE,
      message:
        `Failed to import "${FRONTEND_CORE_MODULE}". ` +
        "Install @alchemy.run/frontend-frameworks in your project to deploy a website.",
      cause,
    }),
}).pipe(Effect.orDie);
