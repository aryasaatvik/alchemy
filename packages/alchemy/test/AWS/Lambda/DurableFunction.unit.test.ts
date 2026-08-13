import {
  durableSelfManagementActions,
  makeDurableListRequest,
  makeDurableSelfManagementPolicyStatements,
} from "@/AWS/Lambda/DurableFunction.ts";
import { describe, expect, it } from "alchemy-test";

describe("DurableFunction management", () => {
  it("passes the qualifier to list requests", () => {
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
      Qualifier: "live",
    });
  });

  it("limits implicit self-management to list, get, and stop", () => {
    expect(durableSelfManagementActions).toEqual({
      list: ["lambda:ListDurableExecutionsByFunction"],
      execution: ["lambda:GetDurableExecution", "lambda:StopDurableExecution"],
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
        Action: ["lambda:GetDurableExecution", "lambda:StopDurableExecution"],
        Resource: ["arn:aws:lambda:us-east-1:123456789012:function:orders:*"],
      },
    ]);
  });
});
