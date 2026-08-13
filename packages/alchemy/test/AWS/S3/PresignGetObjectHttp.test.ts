import { presignGetObjectActions } from "@/AWS/S3/PresignGetObjectHttp.ts";
import { expect, it } from "alchemy-test";

it("grants only the action supported by unversioned presigned GET URLs", () => {
  expect(presignGetObjectActions).toEqual(["s3:GetObject"]);
});
