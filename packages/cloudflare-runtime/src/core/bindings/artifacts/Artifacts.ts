import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { loadInternalWorker } from "../../internal/internal-worker.ts";
const ArtifactsBindingWorker = {
  worker: () =>
    loadInternalWorker("#cloudflare-runtime-core-worker/bindings/artifacts/artifacts.worker"),
};
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as Storage from "../../globals/Storage.ts";
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import type { RemoteBindings } from "../../remote-bindings/RemoteBindings.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import { ArtifactsController } from "./controller.ts";

export interface LocalArtifactsProps {
  binding: string;
  namespace: string;
  /** Public Git listener port. Omit to allocate a free loopback port. */
  gitPort?: number;
}

export class Artifacts extends Plugin.Service<
  Artifacts,
  {
    register: (
      props: LocalArtifactsProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator, ConfigError>;
  }
>()("cloudflare-runtime/plugin/Artifacts") {}

const EXTENSION_MODULE_NAME = "cloudflare-runtime:artifacts";

export const ArtifactsLive = Layer.effect(
  Artifacts,
  Effect.gen(function* () {
    const storage = yield* Storage.Storage;
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new ArtifactsController()),
      (controller) => Effect.promise(() => controller.dispose()),
    );
    return Artifacts.of(
      Effect.gen(function* () {
        const services: WorkerdConfig.Service[] = [];
        const sockets: WorkerdConfig.Socket[] = [];
        const namespaces = new Map<string, WorkerdConfig.ServiceDesignator>();
        return {
          extensions: [
            {
              modules: [
                {
                  name: EXTENSION_MODULE_NAME,
                  internal: true,
                  esModule: yield* formatExtensionModule(ArtifactsBindingWorker),
                },
              ],
            },
          ],
          services,
          sockets,
          api: {
            register: (props) =>
              Effect.tryPromise({
                try: async () => {
                  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(props.namespace)) {
                    throw new Error(`Invalid local Artifacts namespace: ${props.namespace}`);
                  }
                  const existing = namespaces.get(props.namespace);
                  if (existing) return existing;
                  const diskPath = "disk" in storage ? storage.disk?.path : undefined;
                  if (!diskPath)
                    throw new Error("Local Artifacts requires disk-backed runtime storage");
                  const id = createHash("sha256")
                    .update(props.namespace)
                    .digest("hex")
                    .slice(0, 32);
                  const root = path.join(diskPath, "artifacts", id);
                  const metadata = path.join(root, "metadata");
                  await mkdir(metadata, { recursive: true });
                  const { sidecar, port } = await controller.get(
                    path.join(root, "git"),
                    props.gitPort,
                  );
                  const name = `artifacts-${id}`;
                  const service = { name, entrypoint: "LocalArtifactsNamespace" };
                  const script = await loadInternalWorker(
                    "#cloudflare-runtime-core-worker/bindings/artifacts/local-artifacts.worker",
                  );
                  services.push(
                    { name: `${name}-storage`, disk: { path: metadata, writable: true } },
                    {
                      name: `${name}-backend`,
                      external: {
                        address: sidecar.address,
                        http: {
                          injectRequestHeaders: [
                            { name: "X-Local-Artifacts-Backend", value: sidecar.secret },
                          ],
                        },
                      },
                    },
                    {
                      name,
                      worker: {
                        compatibilityDate: "2026-09-03",
                        modules: formatInternalWorkerModules(script),
                        bindings: [
                          {
                            name: "config",
                            json: JSON.stringify({
                              namespace: props.namespace,
                              origin: `http://127.0.0.1:${port}`,
                            }),
                          },
                          {
                            name: "localArtifactsNamespace",
                            durableObjectNamespace: { className: "LocalArtifactsNamespaceObject" },
                          },
                          { name: "gitBackend", service: { name: `${name}-backend` } },
                        ],
                        durableObjectNamespaces: [
                          {
                            className: "LocalArtifactsNamespaceObject",
                            uniqueKey: id,
                            enableSql: true,
                          },
                        ],
                        durableObjectStorage: { localDisk: `${name}-storage` },
                      },
                    },
                  );
                  sockets.push({
                    name: `${name}-git`,
                    address: `127.0.0.1:${port}`,
                    http: {},
                    service,
                  });
                  namespaces.set(props.namespace, service);
                  return service;
                },
                catch: (cause) =>
                  ConfigError.make({
                    subtag: "Artifacts",
                    message: `Unable to start local Artifacts: ${cause instanceof Error ? cause.message : String(cause)}`,
                    cause,
                  }),
              }),
          },
        };
      }),
    );
  }),
);

/** Bind a stage-local Artifacts namespace and authenticated native Git HTTP listener. */
export const local = (props: LocalArtifactsProps): BindingHook<Artifacts> =>
  Plugin.use(Artifacts, (plugin) =>
    Effect.map(plugin.api.register(props), (service) => ({
      name: props.binding,
      service,
    })),
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
    makeRemoteBinding({ name: binding, type: "artifacts", namespace }, (service) => ({
      name: binding,
      wrapped: {
        moduleName: EXTENSION_MODULE_NAME,
        innerBindings: [{ name: "proxyClient", service }],
      },
    })),
  );
