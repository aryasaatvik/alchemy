import { canonicalRecordName } from "@alchemy.run/cloudflare/DNS/Record";
import { describe, expect, it } from "@alchemy.run/test";

describe("Cloudflare DNS record identity", () => {
  it("canonicalizes case and a trailing root label", () => {
    expect(canonicalRecordName("_Acme.Example.com.")).toBe("_acme.example.com");
    expect(canonicalRecordName("_acme.example.com")).toBe("_acme.example.com");
  });
});
