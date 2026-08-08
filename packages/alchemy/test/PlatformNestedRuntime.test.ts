import { shouldInitializePlatform } from "@/Platform.ts";
import { describe, expect, test } from "alchemy-test";

const parent = {
  Type: "AWS.Lambda.Function",
  id: "Api",
};

describe("nested platform runtime initialization", () => {
  test("plan traverses a nested platform declaration", () => {
    expect(
      shouldInitializePlatform(
        "plan",
        parent,
        "AWS.Lambda.Function",
        "Workflows",
      ),
    ).toBe(true);
  });

  test("runtime skips a different platform nested in the entry graph", () => {
    expect(
      shouldInitializePlatform(
        "runtime",
        parent,
        "AWS.Lambda.Function",
        "Workflows",
      ),
    ).toBe(false);
  });

  test("runtime initializes the entry platform itself", () => {
    expect(
      shouldInitializePlatform("runtime", parent, "AWS.Lambda.Function", "Api"),
    ).toBe(true);
  });
});
