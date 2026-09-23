import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
const ArtifactsBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/artifacts/artifacts.worker",
    ),
};
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import type { RemoteBindings } from "../../remote-bindings/RemoteBindings.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";

export class Artifacts extends Plugin.Service<Artifacts>()(
  "cloudflare-runtime/plugin/Artifacts",
) {}

const EXTENSION_MODULE_NAME = "cloudflare-runtime:artifacts";

export const ArtifactsLive = Layer.succeed(
  Artifacts,
  Artifacts.of(
    Effect.map(formatExtensionModule(ArtifactsBindingWorker), (esModule) => ({
      extensions: [
        {
          modules: [
            {
              name: EXTENSION_MODULE_NAME,
              internal: true,
              esModule,
            },
          ],
        },
      ],
    })),
  ),
);

/**
 * Bind to a deployed Artifacts namespace via the remote bindings proxy.
 *
 * Wraps the remote-bindings client so `env.BINDING.get(name)` returns a
 * repository with its metadata (including the Git `remote`) and methods, and
 * failures keep their Artifacts error `code`.
 */
export const remote = (
  binding: string,
  namespace: string,
): BindingHook<RemoteBindings | Artifacts> =>
  Plugin.use(Artifacts, () =>
    makeRemoteBinding(
      { name: binding, type: "artifacts", namespace },
      (service) => ({
        name: binding,
        wrapped: {
          moduleName: EXTENSION_MODULE_NAME,
          innerBindings: [{ name: "proxyClient", service }],
        },
      }),
    ),
  );
