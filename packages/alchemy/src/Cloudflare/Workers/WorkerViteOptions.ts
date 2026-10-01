import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import type * as Path from "effect/Path";
import { initialCwd } from "../../Util/Node.ts";
import { getCompatibility } from "./Compatibility.ts";
import { resolveViteMain } from "./ViteMain.ts";
import type { WorkerProps } from "./Worker.ts";

export const resolveWorkerVitePluginOptions = (
  path: Path.Path,
  props: WorkerProps,
): CloudflareVitePluginOptions => {
  const compatibility = getCompatibility(props);
  return {
    // Explicitly relative entries resolve against the Vite root even when
    // deployment runs from a different directory in a monorepo.
    main: resolveViteMain(
      path,
      path.resolve(initialCwd, props.vite?.rootDir ?? "."),
      props.vite?.main,
    ),
    prerenderWorker: props.vite?.prerenderWorker,
    compatibilityDate: compatibility.date,
    compatibilityFlags: compatibility.flags,
    viteEnvironments: props.vite?.viteEnvironments,
  };
};
