import { describe, expect, test } from "alchemy-test";
import config from "../../tsdown.config.ts";

describe("tsdown config", () => {
  test("externalizes workerd's virtual module from the dev executable", () => {
    expect(config).toHaveLength(1);
    const entry = config[0] as { external?: unknown } | undefined;
    expect(entry?.external).toContain("cloudflare:workers");
  });
});
