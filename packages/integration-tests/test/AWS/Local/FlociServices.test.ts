import { AWS_SERVICE_ENDPOINTS_ENV_VAR } from "@alchemy.run/aws/Environment";
import { placeLocalLambdaEnvironment } from "@alchemy.run/aws/Lambda/FlociFunctionProvider";
import { flociServices } from "@alchemy.run/aws/Local/FlociServices";
import { describe, expect, it } from "@alchemy.run/test";
import { packEnvValue } from "alchemy/RuntimeContext";
import * as Redacted from "effect/Redacted";

describe("flociServices", () => {
  // Binding routing compares data planes by identity, so a binding over two
  // local resources must see one layer reference, not one per registration.
  it("returns the same data-plane layer on every call", () => {
    expect(flociServices()).toBe(flociServices());
  });

  it("places the runtime endpoints and keeps a bound secret encoded", () => {
    const serviceEndpoints = { sesv2: "http://host.docker.internal:8811/ses" };
    expect(
      placeLocalLambdaEnvironment(
        { AWS_ENDPOINT_URL: "http://127.0.0.1:4566", BOUND: packEnvValue(Redacted.make("old")) },
        {
          endpoint: "http://floci:4566",
          serviceEndpoints,
          environment: { BOUND: packEnvValue("false"), RAW: packEnvValue('{"a":1}') },
        },
      ),
    ).toEqual({
      AWS_ENDPOINT_URL: "http://floci:4566",
      [AWS_SERVICE_ENDPOINTS_ENV_VAR]: JSON.stringify(serviceEndpoints),
      BOUND: packEnvValue(Redacted.make("false")),
      RAW: '{"a":1}',
    });
  });
});
