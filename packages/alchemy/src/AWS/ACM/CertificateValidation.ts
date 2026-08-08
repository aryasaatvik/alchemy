import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Action } from "../../Action.ts";
import type { Input } from "../../Input.ts";
import type { Certificate } from "./Certificate.ts";

export class CertificateValidationError extends Data.TaggedError(
  "CertificateValidationError",
)<{
  readonly certificateArn: string;
  readonly status: string;
  readonly reason: string | undefined;
}> {}

export interface CertificateValidationProps {
  /** Certificate whose issuance gates downstream consumers. */
  readonly certificate: Certificate;
  /**
   * External DNS records that must converge before polling ACM. Their values
   * are not sent to ACM; consuming the Outputs creates the dependency edges.
   */
  readonly validationRecordIds: ReadonlyArray<Input<string>>;
}

const waitForIssued = Action(
  "AWS.ACM.CertificateValidation",
  Effect.fn(function* (input: {
    certificateArn: string;
    validationRecordIds: ReadonlyArray<string>;
  }) {
    // Resolved by the Action engine before this runner starts. Keeping the
    // field in the input is what orders this gate after external DNS records.
    void input.validationRecordIds;
    const region = input.certificateArn.split(":")[3] || "us-east-1";
    const detail = yield* acm
      .describeCertificate({ CertificateArn: input.certificateArn })
      .pipe(
        Effect.map((response) => response.Certificate),
        Effect.flatMap((certificate) => {
          if (certificate?.Status === "ISSUED")
            return Effect.succeed(certificate);
          if (
            certificate?.Status === "FAILED" ||
            certificate?.Status === "VALIDATION_TIMED_OUT"
          ) {
            return Effect.fail(
              new CertificateValidationError({
                certificateArn: input.certificateArn,
                status: certificate.Status,
                reason: certificate.FailureReason,
              }),
            );
          }
          return Effect.fail(
            new CertificateValidationError({
              certificateArn: input.certificateArn,
              status: certificate?.Status ?? "PENDING_VALIDATION",
              reason: certificate?.FailureReason,
            }),
          );
        }),
        Effect.retry({
          while: (error) =>
            error._tag === "CertificateValidationError" &&
            error.status !== "FAILED" &&
            error.status !== "VALIDATION_TIMED_OUT",
          schedule: Schedule.max([
            Schedule.fixed("10 seconds"),
            Schedule.recurs(60),
          ]),
        }),
        Effect.provideService(AwsRegion, Effect.succeed(region)),
      );

    return {
      certificateArn: input.certificateArn,
      status: "ISSUED" as const,
    };
  }),
);

/**
 * Wait for an externally DNS-validated ACM certificate to become usable.
 *
 * Pass the external DNS record Outputs so Alchemy orders this Action after
 * those records. Downstream resources should consume the returned
 * `certificateArn`, not the request-time ARN from {@link Certificate}.
 */
export const CertificateValidation = (
  id: string,
  props: CertificateValidationProps,
) =>
  waitForIssued(id, {
    certificateArn: props.certificate.certificateArn,
    validationRecordIds: props.validationRecordIds,
  });
