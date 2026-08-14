import {
  durableSelfManagementActions,
  makeDurableListRequest,
  makeDurableSelfManagementPolicyStatements,
} from "@/AWS/Lambda/DurableFunction.ts";
import { describe, expect, it } from "alchemy-test";

describe("DurableFunction management", () => {
  it("omits the qualifier for an exact-name list request", () => {
    expect(
      makeDurableListRequest("orders", {
        name: "order-123",
        statuses: ["RUNNING"],
        qualifier: "live",
      }),
    ).toEqual({
      FunctionName: "orders",
      DurableExecutionName: "order-123",
      Statuses: ["RUNNING"],
    });
  });

  it("preserves a separate qualifier for an unfiltered list request", () => {
    expect(
      makeDurableListRequest("orders", {
        statuses: ["RUNNING"],
        qualifier: "live",
      }),
    ).toEqual({
      FunctionName: "orders",
      DurableExecutionName: undefined,
      Statuses: ["RUNNING"],
      Qualifier: "live",
    });
  });

  it("preserves an unqualified exact-name list request", () => {
    expect(
      makeDurableListRequest("orders", {
        name: "order-123",
      }),
    ).toEqual({
      FunctionName: "orders",
      DurableExecutionName: "order-123",
      Statuses: undefined,
      Qualifier: undefined,
    });
  });

  it("grants every self-management operation exposed by the handle", () => {
    expect(durableSelfManagementActions).toEqual({
      list: ["lambda:ListDurableExecutionsByFunction"],
      execution: [
        "lambda:GetDurableExecution",
        "lambda:StopDurableExecution",
        "lambda:SendDurableExecutionCallbackSuccess",
        "lambda:SendDurableExecutionCallbackFailure",
        "lambda:SendDurableExecutionCallbackHeartbeat",
      ],
    });
    expect(
      makeDurableSelfManagementPolicyStatements(
        "arn:aws:lambda:us-east-1:123456789012:function:orders",
        "arn:aws:lambda:us-east-1:123456789012:function:orders:*",
      ),
    ).toEqual([
      {
        Effect: "Allow",
        Action: ["lambda:ListDurableExecutionsByFunction"],
        Resource: [
          "arn:aws:lambda:us-east-1:123456789012:function:orders",
          "arn:aws:lambda:us-east-1:123456789012:function:orders:*",
        ],
      },
      {
        Effect: "Allow",
        Action: [
          "lambda:GetDurableExecution",
          "lambda:StopDurableExecution",
          "lambda:SendDurableExecutionCallbackSuccess",
          "lambda:SendDurableExecutionCallbackFailure",
          "lambda:SendDurableExecutionCallbackHeartbeat",
        ],
        Resource: ["arn:aws:lambda:us-east-1:123456789012:function:orders:*"],
      },
    ]);
  });
});
