import { createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalizeToBytes } from "./canonical-json.ts";
import { CcpError } from "./errors.ts";
import {
  ED25519_SIGNATURE_BYTES, WRAPPER_MAX_BYTES, decodeBase64Url, verifyProtectedRequest,
} from "./protocol.ts";
import { parseProtectedRequest, parseSignedProtectedRequest } from "./schemas.ts";
import type { CcBridgeStore, DeviceRecord } from "./store.ts";
import type { ProtectedRequest, SignedProtectedRequest } from "./protocol.ts";

export interface VerifiedDeviceRequest {
  wrapper: SignedProtectedRequest;
  request: ProtectedRequest;
  device: DeviceRecord;
  payloadBytes: Buffer;
}

export interface EnrollmentProofFields {
  challengeId: string;
  challenge: string;
  memberId: string;
  label: string;
  expiresAtMs: number;
  deviceId: string;
  deviceKeyId: string;
  publicKeySpki: string;
}

export function enrollmentProofBytes(fields: EnrollmentProofFields): Buffer {
  return canonicalizeToBytes({
    domain: "ccp-device-enrollment-v1",
    challengeId: fields.challengeId,
    challenge: fields.challenge,
    memberId: fields.memberId,
    label: fields.label,
    expiresAtMs: fields.expiresAtMs,
    deviceId: fields.deviceId,
    deviceKeyId: fields.deviceKeyId,
    publicKeySpki: fields.publicKeySpki,
  });
}

export function verifyEnrollmentProof(
  fields: EnrollmentProofFields,
  proofSignature: string,
  publicKeySpki: Buffer,
): void {
  let signature: Buffer;
  try {
    signature = decodeBase64Url(proofSignature, ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BYTES);
  } catch {
    throw new CcpError("CCP_SIGNATURE_INVALID", "Enrollment proof signature is not canonical Ed25519 data.");
  }
  try {
    const publicKey = createPublicKey({ key: publicKeySpki, format: "der", type: "spki" });
    if (!verifySignature(null, enrollmentProofBytes(fields), publicKey, signature)) {
      throw new Error("signature mismatch");
    }
  } catch {
    throw new CcpError("CCP_SIGNATURE_INVALID", "Enrollment proof of device-key possession did not verify.");
  }
}

export function verifyDeviceRequest(store: CcBridgeStore, rawBody: Buffer, nowMs = Date.now()): VerifiedDeviceRequest {
  if (rawBody.byteLength === 0 || rawBody.byteLength > WRAPPER_MAX_BYTES) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", "Signed request wrapper exceeds the wire cap.", { bytes: rawBody.byteLength });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new CcpError("CCP_CANONICAL_INVALID", "Signed request wrapper is not JSON.");
  }
  let wrapper: SignedProtectedRequest;
  try {
    wrapper = parseSignedProtectedRequest(parsed);
  } catch {
    throw new CcpError("CCP_CANONICAL_INVALID", "Signed request wrapper failed schema checks.");
  }
  const device = store.getDeviceByKeyId(wrapper.deviceKeyId);
  if (!device || device.status !== "approved") {
    throw new CcpError("CCP_DEVICE_DENIED", "Device key is unknown, pending, or revoked.");
  }
  let canonical: unknown;
  try {
    canonical = verifyProtectedRequest(wrapper, createPublicKey({ key: device.publicKeySpki, format: "der", type: "spki" }));
  } catch {
    throw new CcpError("CCP_SIGNATURE_INVALID", "Device signature did not verify.");
  }
  let request: ProtectedRequest;
  try {
    request = parseProtectedRequest(canonical, nowMs);
  } catch (error) {
    if (error instanceof RangeError) throw new CcpError("CCP_EXPIRED", error.message);
    throw new CcpError("CCP_CANONICAL_INVALID", "Protected request failed schema or freshness checks.");
  }
  if (request.deviceId !== device.id) {
    throw new CcpError("CCP_DEVICE_DENIED", "Request device ID does not match the signed key.");
  }
  return { wrapper, request, device, payloadBytes: Buffer.from(wrapper.payload, "base64url") };
}
