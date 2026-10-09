import { KeyLike, sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";
import { canonicalizeToBytes, IJson, parseCanonicalJson } from "./canonical-json";
import type { ExecutionEnvelope } from "./primitive-contract";

export const PROTOCOL_VERSION = 1 as const;
export const EXECUTE_METHOD = "POST" as const;
export const EXECUTE_PATH = "/ccp/v1/execute" as const;
export const REQUEST_PAYLOAD_MAX_BYTES = 256 * 1024;
export const DECISION_PAYLOAD_MAX_BYTES = 512 * 1024;
export const WRAPPER_MAX_BYTES = 360 * 1024;
export const OBSERVATION_MAX_BYTES = 192 * 1024;
export const PRIOR_TELEMETRY_MAX_RECORDS = 16;
export const COMMAND_MAX_COUNT = 100;
export const CREATOR_IPC_MAX_COUNT = 10_001;
export const DECISION_LIFETIME_MAX_MS = 15_000;
export const CLOCK_SKEW_MAX_MS = 30_000;
export const ED25519_SIGNATURE_BYTES = 64;
export const ED25519_SPKI_DER_BYTES = 44;
export const ED25519_PKCS8_DER_BYTES = 48;
export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface SignedProtectedRequest {
  deviceKeyId: string;
  payload: string;
  signature: string;
}

export interface CompletionTelemetry {
  requestId: string;
  outcome: "completed" | "failed" | "outcome-unknown";
  durationMs: number;
  errorCode?: string;
}

export interface ProtectedRequest {
  protocolVersion: 1;
  requestId: string;
  idempotencyKey: string;
  deviceId: string;
  projectId: string;
  relayInstanceId: string;
  sequence: number;
  issuedAtMs: number;
  nonce: string;
  tool: { id: string; contractVersion: number; contractHash: string };
  relay: { build: string; packageHash: string; creatorVersion: string; os: string };
  inputs: IJson;
  observation?: {
    contractId: string;
    consentVersion: string;
    revisionToken: string;
    digest: string;
    fields: IJson;
  };
  priorTelemetry?: CompletionTelemetry[];
}

export interface DecisionBinding {
  requestId: string;
  deviceId: string;
  projectId: string;
  relayInstanceId: string;
  nonce: string;
  sequence: number;
  tool: { id: string; contractVersion: number; contractHash: string };
  relay: { build: string; packageHash: string };
  creatorRange: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type FiniteContractResult =
  | { type: "status"; value: "ok" | "accepted" | "unchanged" }
  | { type: "request-value"; jsonPointer: string }
  | { type: "observation-value"; jsonPointer: string };

export type GatewayDecision =
  | { kind: "result"; binding: DecisionBinding; result: FiniteContractResult; limits: DecisionLimits; correlationId: string }
  | { kind: "execute"; binding: DecisionBinding; envelope: ExecutionEnvelope; correlationId: string };

export interface DecisionLimits {
  outputBytes: number;
  expiresInMs: number;
}

export interface SignedGatewayDecision {
  executionKeyId: string;
  payload: string;
  signature: string;
}

export function assertKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) throw new TypeError("invalid key ID");
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

export function decodeBase64Url(value: string, maxBytes: number, exactBytes?: number): Buffer {
  if (!BASE64URL_PATTERN.test(value) || value.includes("=")) throw new TypeError("invalid unpadded base64url");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.length > maxBytes || encodeBase64Url(decoded) !== value) {
    throw new RangeError("base64url decoded length or encoding is invalid");
  }
  if (exactBytes !== undefined && decoded.length !== exactBytes) throw new RangeError(`decoded value must be ${exactBytes} bytes`);
  return decoded;
}

function signatureBase(domain: "request" | "decision", keyId: string, payload: Uint8Array): Buffer {
  assertKeyId(keyId);
  const prefix = `CCP1 ${domain}\n${EXECUTE_METHOD}\n${EXECUTE_PATH}\n${keyId}\n`;
  return Buffer.concat([Buffer.from(prefix, "utf8"), Buffer.from(payload)]);
}

export function requestSignatureBase(deviceKeyId: string, payload: Uint8Array): Buffer {
  return signatureBase("request", deviceKeyId, payload);
}

export function decisionSignatureBase(executionKeyId: string, payload: Uint8Array): Buffer {
  return signatureBase("decision", executionKeyId, payload);
}

export function signProtectedRequest(deviceKeyId: string, request: ProtectedRequest, privateKey: KeyLike): SignedProtectedRequest {
  const payload = canonicalizeToBytes(request);
  if (payload.length > REQUEST_PAYLOAD_MAX_BYTES) throw new RangeError("request payload exceeds limit");
  return { deviceKeyId, payload: encodeBase64Url(payload), signature: encodeBase64Url(ed25519Sign(null, requestSignatureBase(deviceKeyId, payload), privateKey)) };
}

export function signGatewayDecision(executionKeyId: string, decision: GatewayDecision, privateKey: KeyLike): SignedGatewayDecision {
  const payload = canonicalizeToBytes(decision);
  if (payload.length > DECISION_PAYLOAD_MAX_BYTES) throw new RangeError("decision payload exceeds limit");
  return { executionKeyId, payload: encodeBase64Url(payload), signature: encodeBase64Url(ed25519Sign(null, decisionSignatureBase(executionKeyId, payload), privateKey)) };
}

export function verifyProtectedRequest(wrapper: SignedProtectedRequest, publicKey: KeyLike): IJson {
  assertKeyId(wrapper.deviceKeyId);
  const payload = decodeBase64Url(wrapper.payload, REQUEST_PAYLOAD_MAX_BYTES);
  const signature = decodeBase64Url(wrapper.signature, ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BYTES);
  if (!ed25519Verify(null, requestSignatureBase(wrapper.deviceKeyId, payload), publicKey, signature)) throw new Error("invalid device signature");
  return parseCanonicalJson(payload, REQUEST_PAYLOAD_MAX_BYTES);
}

export function verifyGatewayDecision(wrapper: SignedGatewayDecision, publicKey: KeyLike): IJson {
  assertKeyId(wrapper.executionKeyId);
  const payload = decodeBase64Url(wrapper.payload, DECISION_PAYLOAD_MAX_BYTES);
  const signature = decodeBase64Url(wrapper.signature, ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BYTES);
  if (!ed25519Verify(null, decisionSignatureBase(wrapper.executionKeyId, payload), publicKey, signature)) throw new Error("invalid execution signature");
  return parseCanonicalJson(payload, DECISION_PAYLOAD_MAX_BYTES);
}
