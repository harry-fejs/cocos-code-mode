import { KeyLike, createHash } from "crypto";
import { CcpError } from "./errors";
import {
  CLOCK_SKEW_MAX_MS, GatewayDecision, ProtectedRequest, SignedGatewayDecision,
  decodeBase64Url, verifyGatewayDecision,
} from "./protocol";
import { parseGatewayDecision, parseSignedGatewayDecision, type PublicToolContract } from "./schemas";
import { ReplayAdmission, ReplayWindow } from "./replay-window";

type PublicOperationContract = PublicToolContract["operations"][string];
export interface VerifiedGatewayDecision {
  decision: GatewayDecision;
  decisionDigest: string;
  replay: ReplayAdmission;
  deadlineAtMs: number;
}

export interface DecisionVerificationOptions {
  request: ProtectedRequest;
  signed: SignedGatewayDecision;
  executionKeys: ReadonlyMap<string, KeyLike>;
  replayWindow: ReplayWindow;
  tool: PublicToolContract;
  operation: PublicOperationContract;
  nowMs?: number;
}

function equalToolBinding(left: ProtectedRequest["tool"], right: GatewayDecision["binding"]["tool"]): boolean {
  return left.id === right.id && left.contractVersion === right.contractVersion && left.contractHash === right.contractHash;
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return undefined;
  const version: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return version.every(Number.isSafeInteger) ? version : undefined;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function versionSatisfies(versionText: string, range: string): boolean {
  const version = parseVersion(versionText);
  if (!version) return false;
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(clause);
    if (!match) return false;
    const boundary = parseVersion(match[2]);
    if (!boundary) return false;
    const compared = compareVersion(version, boundary);
    switch (match[1] ?? "=") {
      case ">=": return compared >= 0;
      case "<=": return compared <= 0;
      case ">": return compared > 0;
      case "<": return compared < 0;
      case "=": return compared === 0;
      default: return false;
    }
  });
}

function verifyEnvelopeContract(decision: Extract<GatewayDecision, { kind: "execute" }>, tool: PublicToolContract, operation: PublicOperationContract): void {
  const envelope = decision.envelope;
  if (envelope.effect !== operation.effect) throw new CcpError("CCP_CONTRACT_MISMATCH", "Gateway envelope effect differs from canonical operation metadata.");
  const allowedPrimitives = new Set(operation.primitives);
  for (const command of envelope.commands) {
    if (!allowedPrimitives.has(command.op)) throw new CcpError("CCP_CONTRACT_MISMATCH", "Gateway envelope contains a primitive outside the selected operation.", { op: command.op });
  }
  if (envelope.limits.commandCount > tool.limits.commandCount
    || envelope.limits.ipcCount > tool.limits.creatorIpcCount
    || envelope.limits.inputBytes > tool.limits.inputBytes
    || envelope.limits.outputBytes > tool.limits.outputBytes
    || envelope.limits.timeoutMs > tool.limits.timeoutMs) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", "Gateway envelope exceeds canonical per-operation limits.");
  }
  if (envelope.return.mode !== operation.resultMode) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Gateway envelope result mode differs from canonical operation metadata.");
  }
}

export function verifyDecision(options: DecisionVerificationOptions): VerifiedGatewayDecision {
  let signed: SignedGatewayDecision;
  try { signed = parseSignedGatewayDecision(options.signed); }
  catch { throw new CcpError("CCP_CANONICAL_INVALID", "Gateway decision wrapper is invalid."); }
  const executionKey = options.executionKeys.get(signed.executionKeyId);
  if (!executionKey) throw new CcpError("CCP_SIGNATURE_INVALID", "Gateway execution key is not trusted.", { executionKeyId: signed.executionKeyId });

  let verifiedPayload: unknown;
  try { verifiedPayload = verifyGatewayDecision(signed, executionKey); }
  catch { throw new CcpError("CCP_SIGNATURE_INVALID", "Gateway decision signature or canonical payload is invalid."); }

  let decision: GatewayDecision;
  try { decision = parseGatewayDecision(verifiedPayload); }
  catch { throw new CcpError("CCP_CONTRACT_MISMATCH", "Gateway decision does not match the protected finite contract."); }

  const request = options.request;
  const binding = decision.binding;
  const commonBindingMatches = binding.requestId === request.requestId
    && binding.deviceId === request.deviceId
    && binding.projectId === request.projectId
    && binding.relayInstanceId === request.relayInstanceId
    && binding.nonce === request.nonce
    && binding.sequence === request.sequence
    && equalToolBinding(request.tool, binding.tool);
  if (!commonBindingMatches) throw new CcpError("CCP_CONTRACT_MISMATCH", "Gateway decision binding does not match the signed request.");
  if (binding.relay.build !== request.relay.build || binding.relay.packageHash !== request.relay.packageHash) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Gateway decision relay binding does not match this installed package.");
  }
  if (binding.creatorRange !== options.tool.creatorRange) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Gateway decision Creator range differs from the canonical tool contract.");
  }
  if (!versionSatisfies(request.relay.creatorVersion, binding.creatorRange)) {
    throw new CcpError("CCP_CREATOR_INCOMPATIBLE", "Creator version is outside the signed decision range.", { creatorVersion: request.relay.creatorVersion });
  }

  const nowMs = options.nowMs ?? Date.now();
  if (binding.issuedAtMs > nowMs + CLOCK_SKEW_MAX_MS || binding.expiresAtMs < nowMs) {
    throw new CcpError("CCP_EXPIRED", "Gateway decision is expired or not yet valid.");
  }
  if (decision.kind === "result") {
    if (decision.limits.expiresInMs > binding.expiresAtMs - binding.issuedAtMs || decision.limits.outputBytes > options.tool.limits.outputBytes) {
      throw new CcpError("CCP_LIMIT_EXCEEDED", "Gateway finite result exceeds canonical signed limits.");
    }
  } else {
    verifyEnvelopeContract(decision, options.tool, options.operation);
  }

  const payload = decodeBase64Url(signed.payload, 512 * 1024);
  const decisionDigest = createHash("sha256").update(payload).digest("hex");
  const replay = options.replayWindow.admitDecision(binding.nonce, binding.sequence, decisionDigest, binding.expiresAtMs, nowMs);
  return { decision, decisionDigest, replay, deadlineAtMs: binding.expiresAtMs };
}
