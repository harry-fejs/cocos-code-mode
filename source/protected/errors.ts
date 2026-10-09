export const CCP_ERROR_CODES = [
  "CCP_AUTH_REQUIRED", "CCP_AUTH_INVALID", "CCP_PRODUCT_DENIED", "CCP_DEVICE_DENIED",
  "CCP_PROJECT_DENIED", "CCP_CONTRACT_MISMATCH", "CCP_PRECONDITION_FAILED",
  "CCP_BUILD_INCOMPATIBLE", "CCP_CREATOR_INCOMPATIBLE", "CCP_CANONICAL_INVALID",
  "CCP_SIGNATURE_INVALID", "CCP_EXPIRED", "CCP_REPLAY", "CCP_IDEMPOTENCY_CONFLICT",
  "CCP_LIMIT_EXCEEDED", "CCP_PRIMITIVE_UNKNOWN", "CCP_VALUE_PROVENANCE_INVALID",
  "CCP_PARTIAL_EXECUTION", "CCP_RESULT_TOO_LARGE", "CCP_GATEWAY_UNAVAILABLE",
  "CCP_OUTCOME_UNKNOWN", "CCP_BUSY", "CCP_INTERNAL",
] as const;
export type CcpErrorCode = typeof CCP_ERROR_CODES[number];

export interface CcpErrorBody {
  error: string;
  code: CcpErrorCode;
  details: Record<string, null | boolean | number | string>;
  recovery: string;
}

const RECOVERY_BY_CODE: Record<CcpErrorCode, string> = {
  CCP_AUTH_REQUIRED: "Configure a valid member credential and retry.",
  CCP_AUTH_INVALID: "Re-authenticate, then retry with a newly issued credential.",
  CCP_PRODUCT_DENIED: "Ask an administrator to grant the ccp product.",
  CCP_DEVICE_DENIED: "Re-enroll this device or ask an administrator to approve it.",
  CCP_PROJECT_DENIED: "Ask an administrator to grant this opaque project ID.",
  CCP_CONTRACT_MISMATCH: "Install a compatible signed relay build.",
  CCP_PRECONDITION_FAILED: "Refresh project state and submit a new operation.",
  CCP_BUILD_INCOMPATIBLE: "Install the current permitted signed relay build.",
  CCP_CREATOR_INCOMPATIBLE: "Use a supported Creator version or compatible relay.",
  CCP_CANONICAL_INVALID: "Regenerate the request with the public protocol library.",
  CCP_SIGNATURE_INVALID: "Discard the message and re-establish trusted key state.",
  CCP_EXPIRED: "Create a fresh request after synchronizing system time.",
  CCP_REPLAY: "Create a fresh request; do not reuse nonce or sequence.",
  CCP_IDEMPOTENCY_CONFLICT: "Use a new idempotency key for changed request bytes.",
  CCP_LIMIT_EXCEEDED: "Reduce the bounded request or operation size.",
  CCP_PRIMITIVE_UNKNOWN: "Install a relay compatible with this contract version.",
  CCP_VALUE_PROVENANCE_INVALID: "Use only request, observation, or public contract values.",
  CCP_PARTIAL_EXECUTION: "Inspect the reported commands and use Creator undo or reconcile state.",
  CCP_RESULT_TOO_LARGE: "Use the authenticated local artifact result path.",
  CCP_GATEWAY_UNAVAILABLE: "Restore Gateway connectivity; protected tools do not run offline.",
  CCP_OUTCOME_UNKNOWN: "Reconcile Creator state before issuing any replacement mutation.",
  CCP_BUSY: "Retry after the bounded queue delay using the exact same request bytes.",
  CCP_INTERNAL: "Report the correlation ID; do not retry an effectful call blindly.",
};

export class CcpError extends Error {
  readonly body: CcpErrorBody;

  constructor(code: CcpErrorCode, error: string, details: CcpErrorBody["details"] = {}, recovery = RECOVERY_BY_CODE[code]) {
    super(error);
    this.name = "CcpError";
    this.body = { error, code, details, recovery };
  }
}

export function toCcpErrorBody(error: unknown): CcpErrorBody {
  if (error instanceof CcpError) return error.body;
  return { error: "CCP operation failed.", code: "CCP_INTERNAL", details: {}, recovery: RECOVERY_BY_CODE.CCP_INTERNAL };
}
