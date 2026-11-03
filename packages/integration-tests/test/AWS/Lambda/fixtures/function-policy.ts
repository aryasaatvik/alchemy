import type { PolicyStatement } from "@alchemy.run/aws/IAM/Policy";

/** Synthetic resolved bindings: 37/38 unique grants plus eight repeated grants. */
export const apiPolicyStatements = (variant: "base" | "pr4"): PolicyStatement[] => {
  const statements: PolicyStatement[] = Array.from(
    { length: variant === "base" ? 37 : 38 },
    (_, i) => ({
      Effect: "Allow",
      Action:
        i % 4 === 0
          ? ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"]
          : i % 4 === 1
            ? ["s3:DeleteObject"]
            : i % 4 === 2
              ? ["sqs:SendMessage"]
              : ["iam:PassRole"],
      Resource: [
        `arn:aws:${i % 4 === 2 ? "sqs" : i % 4 === 3 ? "iam" : "s3"}:us-east-1:100000002303:samva-api-artifacts-and-deliveries-local-e2e-4b98fb8c-af57859219-${i.toString().padStart(2, "0")}-resource`,
      ],
      Condition: { StringEquals: { "aws:ResourceAccount": "100000002303" } },
    }),
  );
  return [...statements, ...statements.slice(0, 8)];
};
