import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { fileURLToPath } from "node:url";

const initialHandler = fileURLToPath(
  new URL("./timeout-handler.ts", import.meta.url),
);
const updatedHandler = fileURLToPath(
  new URL("./local-emulator-handler.ts", import.meta.url),
);

const { test } = Test.make({ providers: AWS.providers(), dev: true });

test.provider.skipIf(process.env.AWS_ENDPOINT_URL === undefined)(
  "local mode deploys and updates an ordinary Lambda through the configured emulator",
  (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        AWS.Lambda.Function("LocalEmulatorFunction", {
          main: initialHandler,
          handler: "handler",
          isExternal: true,
        }),
      );
      const initial = yield* Lambda.invoke({
        FunctionName: first.functionName,
        Payload: new TextEncoder().encode("{}"),
      });
      expect(
        yield* Stream.mkString(Stream.decodeText(initial.Payload!)),
      ).toContain("ok");

      const updated = yield* stack.deploy(
        AWS.Lambda.Function("LocalEmulatorFunction", {
          main: updatedHandler,
          handler: "handler",
          isExternal: true,
        }),
      );
      const response = yield* Lambda.invoke({
        FunctionName: updated.functionName,
        Payload: new TextEncoder().encode("{}"),
      });
      expect(
        yield* Stream.mkString(Stream.decodeText(response.Payload!)),
      ).toContain("updated");
    }),
  { timeout: 120_000 },
);
