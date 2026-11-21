import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import ArtifactsEffectWorker from "./fixtures/effect-worker.ts";
import { AsyncWorker } from "./fixtures/stack.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const request = (worker: string, route: string, method: "GET" | "POST" | "DELETE") =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http[method === "DELETE" ? "del" : method === "POST" ? "post" : "get"](
      new URL(route, worker),
    );
    if (response.status !== 200) {
      throw new Error(`${method} ${route}: ${response.status} ${yield* response.text}`);
    }
    return yield* response.json;
  });

test.provider(
  "dispatches both Worker Artifacts bindings to the same local namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { asyncUrl, effectUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          const asyncWorker = yield* AsyncWorker;
          const effectWorker = yield* ArtifactsEffectWorker;
          return {
            asyncUrl: asyncWorker.url.as<string>(),
            effectUrl: effectWorker.url.as<string>(),
          };
        }),
      );
      expect(asyncUrl).toMatch(/^http:\/\/localhost:\d+$/);
      expect(effectUrl).toMatch(/^http:\/\/localhost:\d+$/);
      yield* request(asyncUrl, "/delete?name=binding-proof", "DELETE");
      const created = (yield* request(asyncUrl, "/create?name=binding-proof", "POST")) as {
        remote: string;
        hasToken: boolean;
      };
      expect(created.remote).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/git\//);
      expect(created.hasToken).toBe(true);
      expect(yield* request(effectUrl, "/list", "GET")).toMatchObject({
        names: ["binding-proof"],
      });
      expect(yield* request(effectUrl, "/delete?name=binding-proof", "DELETE")).toEqual({
        deleted: true,
      });
      expect(yield* request(asyncUrl, "/list", "GET")).toMatchObject({ total: 0 });
      yield* stack.destroy();
    }),
  { tags: ["provider:cloudflare", "provider:cloudflare:artifacts", "local"], timeout: 60_000 },
);
