import { hasSamePhysicalIdentity } from "@/Apply.ts";
import { describe, expect, it } from "alchemy-test";

describe("replacement physical identity", () => {
  it("matches only when every declared identity output is present and equal", () => {
    expect(
      hasSamePhysicalIdentity(
        ["accountId", "resourceId"],
        { accountId: "a", resourceId: "r", mutable: "new" },
        { accountId: "a", resourceId: "r", mutable: "old" },
      ),
    ).toBe(true);

    expect(
      hasSamePhysicalIdentity(
        ["accountId", "resourceId"],
        { accountId: "a", resourceId: "r" },
        { accountId: "a", resourceId: "other" },
      ),
    ).toBe(false);

    expect(
      hasSamePhysicalIdentity(
        ["accountId", "resourceId"],
        { accountId: "a", resourceId: "r" },
        { accountId: "a" },
      ),
    ).toBe(false);
    expect(hasSamePhysicalIdentity([], { id: "r" }, { id: "r" })).toBe(false);
  });
});
