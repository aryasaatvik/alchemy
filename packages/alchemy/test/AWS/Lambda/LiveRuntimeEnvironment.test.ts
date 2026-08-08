import { liveChildEnvironment } from "@/AWS/Lambda/Live/LiveRuntime.ts";
import { describe, expect, it } from "alchemy-test";

describe("Live Lambda child environment", () => {
  it("keeps bridge identity and credentials authoritative", () => {
    expect(
      liveChildEnvironment(
        {
          ALCHEMY_LIVE_FUNCTION_ID: "bridge-function",
          ALCHEMY_STAGE: "dev-safe",
          AWS_ACCESS_KEY_ID: "bridge-access-key",
          AWS_SECRET_ACCESS_KEY: "bridge-secret-key",
          AWS_REGION: "us-east-1",
        },
        {
          bundlePath: "/tmp/bundle.js",
          handler: "handler",
          env: {
            ALCHEMY_LIVE_FUNCTION_ID: "app-function",
            ALCHEMY_STAGE: "app-stage",
            AWS_ACCESS_KEY_ID: "app-access-key",
            AWS_SECRET_ACCESS_KEY: "app-secret-key",
            AWS_REGION: "eu-west-1",
            APPLICATION_VALUE: "kept",
          },
        },
      ),
    ).toEqual({
      ALCHEMY_LIVE_FUNCTION_ID: "bridge-function",
      ALCHEMY_STAGE: "dev-safe",
      AWS_ACCESS_KEY_ID: "bridge-access-key",
      AWS_SECRET_ACCESS_KEY: "bridge-secret-key",
      AWS_REGION: "us-east-1",
      APPLICATION_VALUE: "kept",
      ALCHEMY_LIVE_BUNDLE: "/tmp/bundle.js",
      ALCHEMY_LIVE_HANDLER: "handler",
      NODE_OPTIONS: "--enable-source-maps",
    });
  });
});
