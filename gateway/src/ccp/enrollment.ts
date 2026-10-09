import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthContext } from "../auth.ts";
import { verifyEnrollmentProof } from "./device-proof.ts";
import { CcpError } from "./errors.ts";
import {
  ED25519_SPKI_DER_BYTES, KEY_ID_PATTERN, decodeBase64Url,
} from "./protocol.ts";
import type { CcBridgeStore } from "./store.ts";

const ENROLLMENT_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

const ChallengeRequestSchema = z.object({
  label: z.string().min(1).max(64),
}).strict();

const EnrollSchema = z.object({
  challengeId: z.string().uuid(),
  challenge: z.string().min(1).max(64),
  memberId: z.string().min(1).max(128),
  label: z.string().min(1).max(64),
  expiresAtMs: z.number().int().positive(),
  deviceId: z.string().uuid(),
  deviceKeyId: z.string().regex(KEY_ID_PATTERN),
  publicKeySpki: z.string().min(1).max(128),
  proofSignature: z.string().min(1).max(128),
}).strict();

function requireEnrollmentAuth(auth: AuthContext): void {
  if (auth.is_legacy || auth.tokenAlg !== "EdDSA") {
    throw new CcpError("CCP_AUTH_INVALID", "Device enrollment requires an EdDSA member JWT.");
  }
}

function challengeHash(challenge: string): string {
  return createHash("sha256").update(challenge, "utf8").digest("hex");
}

export function issueEnrollmentChallenge(
  store: CcBridgeStore,
  auth: AuthContext,
  body: unknown,
  nowMs = Date.now(),
) {
  requireEnrollmentAuth(auth);
  const { label } = ChallengeRequestSchema.parse(body);
  const challengeId = randomUUID();
  const challenge = randomBytes(32).toString("base64url");
  const expiresAtMs = nowMs + ENROLLMENT_CHALLENGE_LIFETIME_MS;
  store.insertEnrollmentChallenge({
    challengeId,
    challengeHash: challengeHash(challenge),
    memberId: auth.member_id,
    label,
    expiresAtMs,
  }, nowMs);
  return { challengeId, challenge, memberId: auth.member_id, label, expiresAtMs };
}

export function enrollDevice(store: CcBridgeStore, auth: AuthContext, body: unknown, nowMs = Date.now()) {
  requireEnrollmentAuth(auth);
  const parsed = EnrollSchema.parse(body);
  if (parsed.memberId !== auth.member_id) {
    throw new CcpError("CCP_AUTH_INVALID", "Enrollment challenge member does not match the authenticated member.");
  }
  let publicKeySpki: Buffer;
  let challenge: Buffer;
  try {
    publicKeySpki = decodeBase64Url(parsed.publicKeySpki, ED25519_SPKI_DER_BYTES, ED25519_SPKI_DER_BYTES);
    challenge = decodeBase64Url(parsed.challenge, 32, 32);
  } catch {
    throw new CcpError("CCP_CANONICAL_INVALID", "Enrollment key or challenge encoding is invalid.");
  }
  verifyEnrollmentProof(parsed, parsed.proofSignature, publicKeySpki);
  const fingerprint = createHash("sha256").update(publicKeySpki).digest("hex").slice(0, 32);
  try {
    const enrolled = store.enrollDeviceWithChallenge({
      challengeId: parsed.challengeId,
      challengeHash: challengeHash(challenge.toString("base64url")),
      challengeExpiresAtMs: parsed.expiresAtMs,
      device: {
        id: parsed.deviceId,
        keyId: parsed.deviceKeyId,
        memberId: auth.member_id,
        publicKeySpki,
        fingerprint,
        label: parsed.label,
        status: "pending",
      },
      nowMs,
    });
    if (!enrolled) {
      throw new CcpError("CCP_DEVICE_DENIED", "Enrollment challenge is unknown, expired, mismatched, or already used.");
    }
  } catch (error) {
    if (error instanceof CcpError) throw error;
    if (error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) {
      throw new CcpError("CCP_DEVICE_DENIED", "Device ID, key ID, or public-key fingerprint is already enrolled.");
    }
    throw error;
  }
  return { deviceId: parsed.deviceId, fingerprint, status: "pending" as const };
}

export function approveEnrolledDevice(store: CcBridgeStore, auth: AuthContext, deviceId: string, nowMs = Date.now()) {
  if (auth.role !== "admin") throw new CcpError("CCP_AUTH_INVALID", "Only an admin can approve a device.");
  if (!z.string().uuid().safeParse(deviceId).success) throw new CcpError("CCP_CANONICAL_INVALID", "Device ID is not a UUID.");
  if (!store.approveDevice(deviceId, nowMs)) throw new CcpError("CCP_DEVICE_DENIED", "Device is not pending approval.");
  return { deviceId, status: "approved" as const };
}

const GrantSchema = z.object({
  memberId: z.string().min(1).max(128).nullable().optional(),
  deviceId: z.string().uuid().nullable().optional(),
  projectId: z.string().min(1).max(128).nullable().optional(),
  toolId: z.string().min(1).max(128).nullable().optional(),
  operationClass: z.enum(["read", "mutation", "capture", "control"]),
  expiresAtMs: z.number().int().positive().nullable().optional(),
}).strict();

function requireAdmin(auth: AuthContext): void {
  if (auth.role !== "admin") throw new CcpError("CCP_AUTH_INVALID", "Only an admin can manage devices and grants.");
}

export function listAdminDevices(store: CcBridgeStore, auth: AuthContext) {
  requireAdmin(auth);
  return { devices: store.listDevices().map(({ publicKeySpki, ...rest }) => rest) };
}

export function revokeEnrolledDevice(store: CcBridgeStore, auth: AuthContext, deviceId: string, nowMs = Date.now()) {
  requireAdmin(auth);
  if (!z.string().uuid().safeParse(deviceId).success) throw new CcpError("CCP_CANONICAL_INVALID", "Device ID is not a UUID.");
  if (!store.revokeDevice(deviceId, nowMs)) throw new CcpError("CCP_DEVICE_DENIED", "Device is already revoked or missing.");
  return { deviceId, status: "revoked" as const };
}

export function createGrant(store: CcBridgeStore, auth: AuthContext, body: unknown, nowMs = Date.now()) {
  requireAdmin(auth);
  const parsed = GrantSchema.parse(body);
  const id = randomUUID();
  store.insertGrant({
    id,
    memberId: parsed.memberId ?? null,
    deviceId: parsed.deviceId ?? null,
    projectId: parsed.projectId ?? null,
    toolId: parsed.toolId ?? null,
    operationClass: parsed.operationClass,
    expiresAtMs: parsed.expiresAtMs ?? null,
    status: "active",
  }, nowMs);
  return { grantId: id, status: "active" as const };
}

export function listAdminGrants(store: CcBridgeStore, auth: AuthContext) {
  requireAdmin(auth);
  return { grants: store.listGrants() };
}

export function revokeAdminGrant(store: CcBridgeStore, auth: AuthContext, grantId: string) {
  requireAdmin(auth);
  if (!z.string().uuid().safeParse(grantId).success) throw new CcpError("CCP_CANONICAL_INVALID", "Grant ID is not a UUID.");
  if (!store.revokeGrant(grantId)) throw new CcpError("CCP_DEVICE_DENIED", "Grant is already revoked or missing.");
  return { grantId, status: "revoked" as const };
}
