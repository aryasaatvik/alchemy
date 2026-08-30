import * as Layer from "effect/Layer";
import { DockerLive } from "../Docker/Docker.ts";
import * as RpcServer from "../Local/RpcServer.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import { LocalContainerProvider } from "./Containers/LocalContainerProvider.ts";
import * as Credentials from "./Credentials.ts";
import { ProviderLocal as D1ProviderLocal } from "./D1/Database.ts";
import {
  localEnvironment,
  provideLocalEnvironment,
  retainedLiveEnvironment,
} from "./LocalEnvironment.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import { ProviderLocal } from "./Queues/Queue.ts";
import { ConsumerProviderLocal } from "./Queues/Consumer.ts";
import { SecretProviderLocal } from "./SecretsStore/Secret.ts";
import { LocalWorkerProvider } from "./Workers/LocalWorkerProvider.ts";

const cloudflareServices = Layer.provide(
  Layer.mergeAll(
    Credentials.fromAuthProvider(),
    localEnvironment,
    retainedLiveEnvironment,
  ),
  CloudflareAuth,
);

Layer.mergeAll(
  LocalWorkerProvider(),
  LocalContainerProvider(),
  ProviderLocal(),
  ConsumerProviderLocal(),
  D1ProviderLocal(),
  SecretProviderLocal(),
).pipe(
  Layer.provide(localRuntimeServices()),
  provideLocalEnvironment,
  Layer.provide(cloudflareServices),
  Layer.provide(DockerLive),
  RpcServer.launch,
);
