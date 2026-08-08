import type { Certificate } from "@/AWS/ACM/Certificate.ts";
import * as AWS from "@/AWS";
import * as Plan from "@/Plan.ts";
import * as Stack from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Bucket, TestLayers } from "../../test.resources.ts";

const { test } = Test.make({
  providers: TestLayers(),
  state: inMemoryState(),
});

test(
  "orders DNS validation before the issued-certificate gate",
  Effect.gen(function* () {
    const plan = yield* Effect.gen(function* () {
      // The resource shapes are deliberately minimal: this is a graph test,
      // not a live ACM request. The certificate ARN and DNS record ID are
      // resource Outputs so the action must wait for both before it polls.
      const certificateRequest = yield* Bucket("CertificateRequest", {
        name: "arn:aws:acm:us-east-1:123456789012:certificate/test",
      });
      const validationRecord = yield* Bucket("ValidationRecord", {
        name: "_acm-validation.example.test",
      });
      const issued = yield* AWS.ACM.CertificateValidation("CertificateIssued", {
        certificate: {
          certificateArn: certificateRequest.name,
        } as unknown as Certificate,
        validationRecordIds: [validationRecord.name],
      });

      // Consumers take the Action output, never the request-time ARN: they
      // therefore cannot run until its ACM polling body observes ISSUED.
      return yield* Bucket("CertificateConsumer", {
        name: issued.certificateArn,
      });
    }).pipe(
      // @ts-expect-error - Stack.make's typing erases R unsoundly here
      Stack.make({
        name: "acm-certificate-validation",
        providers: Layer.empty,
        state: inMemoryState(),
      }),
      Effect.provideService(Stage, "test"),
      Effect.flatMap((stack: any) => Plan.make(stack)),
      Effect.provide(TestLayers()),
    ) as Effect.Effect<any, any, any>;

    expect(plan.actions.CertificateIssued).toMatchObject({
      kind: "action",
      action: "run",
    });
    expect(plan.resources.CertificateRequest.downstream).toContain(
      "CertificateIssued",
    );
    expect(plan.resources.ValidationRecord.downstream).toContain(
      "CertificateIssued",
    );
    expect(plan.actions.CertificateIssued.downstream).toContain(
      "CertificateConsumer",
    );
  }),
);
