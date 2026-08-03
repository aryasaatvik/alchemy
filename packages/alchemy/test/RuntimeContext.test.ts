import { reifyBoundConfigProvider } from "@/Runtime";
import {
  isPackedEnvValue,
  packEnvValue,
  packEnvValueKeepRedacted,
  unpackEnvValue,
} from "@/RuntimeContext";
import { describe, expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

describe("RuntimeContext environment values", () => {
  it("preserves every unprefixed environment value as a string", () => {
    for (const raw of [
      "100000000004",
      "42",
      "true",
      "false",
      "null",
      '"quoted"',
      '{"enabled":true}',
      '["json","array"]',
    ]) {
      expect(unpackEnvValue(raw)).toBe(raw);
    }
    expect(unpackEnvValue(undefined)).toBeUndefined();
  });

  it("does not reinterpret the ambiguous legacy JSON wire", () => {
    const legacyNumber = "100000000004";
    const legacySecret = '{"_tag":"Redacted","value":"secret"}';
    expect(unpackEnvValue(legacyNumber)).toBe(legacyNumber);
    expect(unpackEnvValue(legacySecret)).toBe(legacySecret);
  });

  it("round-trips explicitly packed JSON values", () => {
    for (const value of [
      "100000000004",
      42,
      true,
      false,
      null,
      { enabled: true },
      ["json", 1],
    ]) {
      const packed = packEnvValue(value);
      expect(isPackedEnvValue(packed)).toBe(true);
      expect(unpackEnvValue(packed)).toEqual(value);
    }
    expect(() => packEnvValue(undefined)).toThrow(
      "Cannot pack undefined as an environment value",
    );
  });

  it("round-trips packed secrets without exposing the outer secret channel", () => {
    const secret = Redacted.make({ token: "secret" });
    const packed = packEnvValue(secret);
    const unpacked = unpackEnvValue(packed);
    expect(Redacted.isRedacted(unpacked)).toBe(true);
    expect(Redacted.value(unpacked as Redacted.Redacted<unknown>)).toEqual({
      token: "secret",
    });

    const kept = packEnvValueKeepRedacted(secret);
    expect(Redacted.isRedacted(kept)).toBe(true);
    const keptPacked = Redacted.value(kept as Redacted.Redacted<string>);
    expect(isPackedEnvValue(keptPacked)).toBe(true);
    expect(
      Redacted.value(unpackEnvValue(keptPacked) as Redacted.Redacted<unknown>),
    ).toEqual({ token: "secret" });
  });

  it.effect(
    "reifies only packed values for generated runtime Config reads",
    () => {
      const env = {
        RAW_ACCOUNT_ID: "100000000004",
        RAW_BOOLEAN: "false",
        RAW_NULL: "null",
        RAW_JSON: '{"enabled":true}',
        PACKED_STRING: packEnvValue("bound"),
        PACKED_NUMBER: packEnvValue(42),
        PACKED_BOOLEAN: packEnvValue(true),
        PACKED_JSON: packEnvValue({ enabled: true }),
        PACKED_SECRET: Redacted.value(
          packEnvValueKeepRedacted(
            Redacted.make("secret"),
          ) as Redacted.Redacted<string>,
        ),
      };
      const provider = reifyBoundConfigProvider(
        ConfigProvider.fromUnknown(env),
        env,
      );

      return Effect.gen(function* () {
        const values = yield* Effect.all({
          rawAccountId: Config.string("RAW_ACCOUNT_ID"),
          rawBoolean: Config.string("RAW_BOOLEAN"),
          rawNull: Config.string("RAW_NULL"),
          rawJson: Config.string("RAW_JSON"),
          packedString: Config.string("PACKED_STRING"),
          packedNumber: Config.number("PACKED_NUMBER"),
          packedBoolean: Config.boolean("PACKED_BOOLEAN"),
          packedJson: Config.string("PACKED_JSON"),
          packedSecret: Config.redacted("PACKED_SECRET"),
        });

        expect(values.rawAccountId).toBe("100000000004");
        expect(values.rawBoolean).toBe("false");
        expect(values.rawNull).toBe("null");
        expect(values.rawJson).toBe('{"enabled":true}');
        expect(values.packedString).toBe("bound");
        expect(values.packedNumber).toBe(42);
        expect(values.packedBoolean).toBe(true);
        expect(values.packedJson).toBe('{"enabled":true}');
        expect(Redacted.value(values.packedSecret)).toBe("secret");
      }).pipe(Effect.provide(ConfigProvider.layer(provider)));
    },
  );
});
