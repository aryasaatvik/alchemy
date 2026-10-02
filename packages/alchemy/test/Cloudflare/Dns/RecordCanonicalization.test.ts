import { canonicalRecordName } from "@/Cloudflare/DNS/Record.ts";
import { describe, expect, it } from "alchemy-test";

describe("Cloudflare DNS record identity", () => {
  it("canonicalizes case and a trailing root label", () => {
    expect(canonicalRecordName("_Acme.Example.com.")).toBe("_acme.example.com");
    expect(canonicalRecordName("_acme.example.com")).toBe("_acme.example.com");
  });
});
