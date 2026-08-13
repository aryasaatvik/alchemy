import { getSecretValueActions } from "@/AWS/SecretsManager/GetSecretValueHttp.ts";
import { expect, it } from "alchemy-test";

it("grants only GetSecretValue for the runtime read", () => {
  expect(getSecretValueActions).toEqual(["secretsmanager:GetSecretValue"]);
});
