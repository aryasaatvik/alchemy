import { findCycleComponents, inSameCycle } from "@/Util/scc.ts";
import { describe, expect, test } from "alchemy-test";

describe("strongly-connected components", () => {
  test("preserves identity across self-cycles, mutual peers, and distinct SCCs", () => {
    const components = findCycleComponents({
      SelfA: ["SelfA"],
      SelfB: ["SelfB", "SelfA"],
      PeerA: ["PeerB"],
      PeerB: ["PeerA"],
      External: ["PeerA"],
      Acyclic: [],
    });

    expect(components.get("SelfA")).toBe("SelfA");
    expect(components.get("SelfB")).toBe("SelfB");
    expect(inSameCycle(components, "SelfA", "SelfB")).toBe(false);

    expect(components.get("PeerA")).toBe("PeerA");
    expect(components.get("PeerB")).toBe("PeerA");
    expect(inSameCycle(components, "PeerA", "PeerB")).toBe(true);

    expect(components.has("External")).toBe(false);
    expect(components.has("Acyclic")).toBe(false);
    expect(inSameCycle(components, "External", "PeerA")).toBe(false);
  });
});
