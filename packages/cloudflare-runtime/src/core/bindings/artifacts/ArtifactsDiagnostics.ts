const operations = [
  "metadata",
  "create",
  "import",
  "list",
  "delete",
  "info",
  "createToken",
  "listTokens",
  "revokeToken",
  "fork",
  "readBlob",
  "readTree",
  "readCommit",
  "readFile",
  "log",
  "session",
] as const;
const stages = [
  "session-open",
  "dispatch",
  "native-get",
  "native-call",
  "native-createToken",
  "native-dispose",
  "serialize",
  "envelope",
  "methods-dispose",
  "session-dispose",
  "forward",
] as const;
const outcomes = ["begin", "success", "failure"] as const;
const origins = ["native", "bridge-fallback"] as const;
const transports = ["rpc", "fetch", "envelope"] as const;
const codes = [
  "ALREADY_EXISTS",
  "NOT_FOUND",
  "CREATE_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "FORK_IN_PROGRESS",
  "INVALID_INPUT",
  "INVALID_REPO_NAME",
  "INVALID_TTL",
  "INVALID_URL",
  "REMOTE_AUTH_REQUIRED",
  "UPSTREAM_UNAVAILABLE",
  "MEMORY_LIMIT",
  "INTERNAL_ERROR",
] as const satisfies ReadonlyArray<ArtifactsErrorCode>;

export type ArtifactsOperation = (typeof operations)[number];
type Stage = (typeof stages)[number];
export interface ArtifactsDiagnostic {
  readonly operation: ArtifactsOperation;
  readonly stage: Stage;
  readonly outcome: (typeof outcomes)[number];
  readonly origin?: (typeof origins)[number];
  readonly code?: ArtifactsErrorCode;
  readonly numericCode?: number;
  readonly httpStatus?: number;
  readonly upgrade?: boolean;
  readonly transport?: (typeof transports)[number];
}

const MAX_EVENTS = 16;
const member = <A extends string>(values: readonly A[], value: unknown) =>
  values.find((candidate) => candidate === value);
const own = (value: unknown, key: PropertyKey): unknown => {
  try {
    return (typeof value === "object" && value !== null) || typeof value === "function"
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  } catch {
    return undefined;
  }
};
const bounded = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** Diagnostics read data properties only; rejected capabilities and getters stay untouched. */
export const artifactErrorFields = (error: unknown) => {
  const code = member(codes, own(error, "code"));
  const numericCode = own(error, "numericCode");
  return {
    ...(code === undefined ? {} : { code }),
    ...(bounded(numericCode, 0, 2_147_483_647) ? { numericCode } : {}),
  };
};

const safeDiagnostic = (value: unknown): ArtifactsDiagnostic | undefined => {
  const operation = member(operations, own(value, "operation"));
  const stage = member(stages, own(value, "stage"));
  const outcome = member(outcomes, own(value, "outcome"));
  if (operation === undefined || stage === undefined || outcome === undefined) return;
  const origin = member(origins, own(value, "origin"));
  const transport = member(transports, own(value, "transport"));
  const httpStatus = own(value, "httpStatus");
  const upgrade = own(value, "upgrade");
  return {
    operation,
    stage,
    outcome,
    ...artifactErrorFields(value),
    ...(origin === undefined ? {} : { origin }),
    ...(transport === undefined ? {} : { transport }),
    ...(bounded(httpStatus, 100, 599) ? { httpStatus } : {}),
    ...(typeof upgrade === "boolean" ? { upgrade } : {}),
  };
};

/** This prefix is emitted by local workerd into the native runtime's output sink. */
export const emitArtifactDiagnostic = (value: unknown) => {
  try {
    const event = safeDiagnostic(value);
    if (event !== undefined) console.log(`[artifacts-rpc] ${JSON.stringify(event)}`);
  } catch {
    // Observability must never replace the operation or its disposal error.
  }
};

/** Only the bounded sidecar is inspected; business values and error messages are never logged. */
export const relayArtifactDiagnostics = (result: unknown) => {
  try {
    const envelope = typeof result === "string" ? JSON.parse(result) : result;
    const events = own(envelope, "diagnostics");
    if (!Array.isArray(events)) return true;
    for (let index = 0; index < MAX_EVENTS; index++) {
      const event = safeDiagnostic(own(events, index));
      if (event !== undefined) emitArtifactDiagnostic(event);
    }
    return true;
  } catch {
    // Decoding the business envelope remains the facade's responsibility.
    return false;
  }
};

/** One finite sidecar travels with the native envelope, independently of remote console output. */
export class ArtifactsDiagnostics {
  readonly events: ArtifactsDiagnostic[] = [];
  constructor(readonly operation: ArtifactsOperation) {}
  record(
    stage: Stage,
    outcome: ArtifactsDiagnostic["outcome"],
    error?: unknown,
    origin: ArtifactsDiagnostic["origin"] = "native",
  ) {
    if (this.events.length < MAX_EVENTS)
      this.events.push({
        operation: this.operation,
        stage,
        outcome,
        ...(outcome === "failure" ? { origin, ...artifactErrorFields(error) } : {}),
      });
  }
  async run<A>(stage: Stage, operation: () => Promise<A>): Promise<A> {
    this.record(stage, "begin");
    try {
      const value = await operation();
      this.record(stage, "success");
      return value;
    } catch (error) {
      this.record(stage, "failure", error);
      throw error;
    }
  }
  lifetime(repository: ArtifactsRepo): Disposable {
    // `using` captures the disposer before invoking the operation, including its receiver.
    const dispose = repository[Symbol.dispose];
    return {
      [Symbol.dispose]: () => {
        this.record("native-dispose", "begin");
        try {
          dispose.call(repository);
          this.record("native-dispose", "success");
        } catch (error) {
          this.record("native-dispose", "failure", error);
          throw error;
        }
      },
    };
  }
}
