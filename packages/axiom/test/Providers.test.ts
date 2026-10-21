import type * as SDK from "@distilled.cloud/axiom";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AxiomAuth } from "../src/AuthProvider.ts";
import * as Credentials from "../src/Credentials.ts";
import { Dataset, DatasetProvider } from "../src/Dataset.ts";
import { providers } from "../src/Providers.ts";

const options = { tags: ["unit", "local"], exclusive: true, timeout: 10_000 };

// ALCHEMY_HOME is process-global, so these tests run exclusively.
const withEmptyProfile = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-axiom-providers-" });
    const previous = process.env.ALCHEMY_HOME;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.ALCHEMY_HOME = home;
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.ALCHEMY_HOME;
          else process.env.ALCHEMY_HOME = previous;
        }),
    );
    let requests = 0;
    const result = yield* effect.pipe(
      Effect.provideService(AuthProviders, {}),
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign(
          () => {
            requests++;
            throw new Error("Network is forbidden in the Axiom provider regression");
          },
          {
            preconnect: () => {
              throw new Error("Network preconnect is forbidden");
            },
          },
        ),
      ),
      Effect.provideService(Stack, {
        name: "axiom-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CI: false }))),
    );
    expect(requests).toBe(0);
    return result;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live(
  "builds every Axiom provider without credentials or resources",
  () => withEmptyProfile(Layer.build(providers())),
  options,
);

it.live(
  "Dataset list still requires credentials on first use",
  () =>
    withEmptyProfile(
      Effect.gen(function* () {
        const provider = yield* Dataset.Provider;
        const exit = yield* Effect.exit(provider.list());
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("CredentialsUnavailable");
          expect(Cause.pretty(exit.cause)).toContain(
            "Provider 'Axiom' is not configured in profile 'default'",
          );
        }
      }).pipe(
        Effect.provide(
          DatasetProvider().pipe(
            Layer.provide(
              Credentials.fromAuthProvider().pipe(
                Layer.provideMerge(AxiomAuth.pipe(Layer.provide(CredentialsStoreLive))),
                Layer.provideMerge(ProfileStoreLive),
              ),
            ),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      ),
    ),
  options,
);

const context = {
  id: "Logs",
  fqn: "Logs",
  instanceId: "logs",
  oldBindings: [],
  newBindings: [],
  bindings: [],
  session: { emit: () => Effect.void, done: () => Effect.void, note: () => Effect.void },
};

const dataset: SDK.Dataset = {
  id: "logs",
  name: "logs",
  kind: "otel:logs:v1",
  created: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
  who: "test",
  description: "Logs\n[alchemy:stack=axiom-test;stage=test;id=Logs]",
  edgeDeployment: "test-edge",
  edgeDeploymentUrl: "https://edge.example.test/",
};

const withDataset = <A, E, R>(effect: Effect.Effect<A, E, R>, responses: Response[]) => {
  let resolutions = 0;
  const requests: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.method);
      const response = responses.shift();
      if (!response) throw new Error(`Unscripted Axiom request: ${request.method} ${request.url}`);
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return Effect.gen(function* () {
    expect(resolutions).toBe(0);
    const result = yield* effect;
    expect(resolutions).toBeGreaterThan(0);
    expect(responses).toHaveLength(0);
    return { result, requests };
  }).pipe(
    Effect.provide(DatasetProvider()),
    Effect.provideService(
      Credentials.Credentials,
      Effect.sync(() => {
        resolutions++;
        return { apiKey: Redacted.make("unit-test-only"), apiBaseUrl: "https://api.example.test/" };
      }),
    ),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(Stack, {
      name: "axiom-test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Effect.provideService(Stage, "test"),
  );
};

it.effect(
  "preserves dataset and OTLP attributes through list, read, create and update",
  () =>
    Effect.gen(function* () {
      const { result, requests } = yield* withDataset(
        Effect.gen(function* () {
          const provider = yield* Dataset.Provider;
          const listed = yield* provider.list();
          const read = yield* provider.read!({
            ...context,
            olds: { name: "logs" },
            output: undefined,
          });
          const created = yield* provider.reconcile({
            ...context,
            olds: undefined,
            news: { name: "logs", description: "Logs" },
            output: undefined,
          });
          const updated = yield* provider.reconcile({
            ...context,
            olds: { name: "logs" },
            news: { name: "logs", description: "Updated" },
            output: created,
          });
          return { listed, read, created, updated };
        }),
        [
          Response.json([dataset]),
          Response.json(dataset),
          Response.json({ message: "missing" }, { status: 404 }),
          Response.json(dataset),
          Response.json(dataset),
          Response.json({ ...dataset, description: "Updated" }),
        ],
      );
      const expected = {
        id: "logs",
        name: "logs",
        description: "Logs",
        apiBaseUrl: "https://api.example.test",
        edgeDeploymentUrl: "https://edge.example.test/",
        otelEndpoint: "https://edge.example.test",
        otelTracesEndpoint: "https://edge.example.test/v1/traces",
        otelLogsEndpoint: "https://edge.example.test/v1/logs",
        otelMetricsEndpoint: "https://edge.example.test/v1/metrics",
        otelHeaders: { "X-Axiom-Dataset": "logs" },
      };
      expect(result.listed).toHaveLength(1);
      expect(result.listed[0]).toMatchObject(expected);
      expect(result.read).toMatchObject(expected);
      expect(result.created).toMatchObject(expected);
      expect(result.updated).toMatchObject({ ...expected, description: "Updated" });
      expect(requests).toEqual(["GET", "GET", "GET", "POST", "GET", "PUT"]);
    }),
  options,
);

it.effect(
  "rejects missing edge metadata during attribute conversion",
  () =>
    Effect.gen(function* () {
      const { result } = yield* withDataset(
        Effect.gen(function* () {
          const provider = yield* Dataset.Provider;
          return yield* Effect.exit(provider.list());
        }),
        [Response.json([{ ...dataset, edgeDeploymentUrl: undefined }])],
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(
          'Axiom dataset "logs" is missing its edge deployment metadata',
        );
      }
    }),
  options,
);
