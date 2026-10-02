import { flociServices } from "@/AWS/Local/FlociServices.ts";
import { describe, expect, it } from "alchemy-test";

describe("flociServices", () => {
  // Binding routing compares data planes by identity, so a binding over two
  // local resources must see one layer reference, not one per registration.
  it("returns the same data-plane layer on every call", () => {
    expect(flociServices()).toBe(flociServices());
  });
});
