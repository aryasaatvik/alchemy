import * as AWS from "@/AWS";
import {
  AWS_SERVICE_ENDPOINTS_ENV_VAR,
  AWSEnvironment,
} from "@/AWS/Environment.ts";
import { inMemoryState } from "@/State/index.ts";
import * as Test from "@/Test/Alchemy";
import { packEnvValue } from "@/RuntimeContext.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  LocalProfileProbe,
  LocalProfileProbeProvider,
} from "./fixtures/local-profile/probe.ts";

/**
 * `AWS.providers({ local, serviceEndpoints })` selects the emulator account,
 * region and endpoint (and the Lambda container placement) of every local
 * AWS provider — including the ones the dev sidecar hosts, which only see
 * what the session carries.
 *
 * The endpoints are never dialed: a custom endpoint is caller-owned (no
 * `ensureFloci`) and the probe only observes its context, so no emulator or
 * Docker is needed.
 */
const LOCAL = {
  accountId: "100000000042",
  region: "eu-west-1",
  endpoint: "http://127.0.0.1:45999",
};
const SES_ENDPOINT = "http://127.0.0.1:45998/ses";
const CONTAINER_DATABASE_URL = "postgres://postgres:5432/db";
const LAMBDA = {
  endpoint: "http://floci:4566",
  serviceEndpoints: { ses: "http://host.docker.internal:45998/ses" },
  environment: { DATABASE_URL: Redacted.make(CONTAINER_DATABASE_URL) },
};

const providers = LocalProfileProbeProvider().pipe(
  Layer.provideMerge(
    AWS.providers({
      local: { ...LOCAL, lambda: LAMBDA },
      serviceEndpoints: { sesv2: SES_ENDPOINT },
    }),
  ),
);

const sidecar = Test.make({ providers, dev: true, state: inMemoryState() });
const inProcess = Test.make({
  providers,
  dev: true,
  sidecar: false,
  state: inMemoryState(),
});

const expectedProbe = {
  ...LOCAL,
  emulator: true,
  s3Endpoint: LOCAL.endpoint,
  sesEndpoint: SES_ENDPOINT,
  // The container placement arrives intact, and the replaced secret stays
  // marker-packed (Redacted at runtime).
  lambdaEnvironment: {
    DATABASE_URL: packEnvValue(Redacted.make(CONTAINER_DATABASE_URL)),
    PLAIN: "unchanged",
    AWS_ENDPOINT_URL: LAMBDA.endpoint,
    [AWS_SERVICE_ENDPOINTS_ENV_VAR]: JSON.stringify(LAMBDA.serviceEndpoints),
  },
};

const program = Effect.gen(function* () {
  const probe = yield* LocalProfileProbe("Probe", {});
  const ambient = yield* AWSEnvironment.current;
  return {
    probe,
    ambient: {
      accountId: ambient.accountId,
      region: ambient.region,
      endpoint: ambient.endpoint,
    },
  };
});

sidecar.test.provider(
  "the local profile reaches sidecar-hosted providers and the dev ambient",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { probe, ambient } = yield* stack.deploy(program);

      expect(probe).toMatchObject(expectedProbe);
      // Proof the lifecycle ran in the sidecar, not this process.
      expect(probe.pid).not.toBe(process.pid);
      expect(ambient).toEqual(LOCAL);

      yield* stack.destroy();
    }),
  { timeout: 90_000, tags: ["provider:aws", "local"] },
);

inProcess.test.provider(
  "the local profile reaches in-process local providers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { probe, ambient } = yield* stack.deploy(program);

      expect(probe).toMatchObject(expectedProbe);
      expect(probe.pid).toBe(process.pid);
      expect(ambient).toEqual(LOCAL);

      yield* stack.destroy();
    }),
  { timeout: 90_000, tags: ["provider:aws", "local"] },
);
