import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { RuntimeError, SystemError } from "../RuntimeError.shared.ts";

const ErrorEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(false),
  error: RuntimeError,
});
type EncodedErrorEnvelope = Schema.Codec.Encoded<typeof ErrorEnvelopeSchema>;

const encodeErrorResponse = Schema.encodeSync(ErrorEnvelopeSchema);
const decodeErrorResponse = Schema.decodeUnknownResult(ErrorEnvelopeSchema);

export const makeErrorEnvelope = (error: RuntimeError): EncodedErrorEnvelope =>
  encodeErrorResponse({ ok: false, error });

export const makeErrorResponse = (
  error: RuntimeError,
  init?: { status?: number; headers?: Record<string, string> },
): Response =>
  Response.json(makeErrorEnvelope(error), {
    status: init?.status ?? 500,
    headers: { "content-type": "application/json", ...init?.headers },
  });

export const decodeResponse = async <T>(response: Response) => {
  const text = await response.text().catch(() => "");
  let json: { ok: true; result: T } | EncodedErrorEnvelope;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SystemError({
      subtag: "InvalidResponse",
      message: `Invalid response from server (${response.status} ${response.statusText})`,
      detail: { status: response.status, body: text },
    });
  }
  if (json.ok) {
    return json.result;
  }
  const decoded = decodeErrorResponse(json);
  if (Result.isSuccess(decoded)) {
    throw decoded.success.error;
  }
  throw new SystemError({
    subtag: "InvalidResponse",
    message: `Invalid response from server (${response.status} ${response.statusText})`,
    detail: { status: response.status, body: text },
  });
};
