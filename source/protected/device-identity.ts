import {
  KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign,
} from "crypto";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import {
  ED25519_PKCS8_DER_BYTES, ED25519_SPKI_DER_BYTES, encodeBase64Url,
} from "./protocol";
import { decodeBase64UrlBuffer, randomUUID } from "./node14-compat";
import { readPrivateJson, writePrivateJsonAtomic } from "./durable-file";
import { canonicalizeToBytes } from "./canonical-json";

const IdentitySchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().uuid(),
  deviceKeyId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  publicKeyDer: z.string().regex(/^[A-Za-z0-9_-]+$/),
  privateKeyDer: z.string().regex(/^[A-Za-z0-9_-]+$/),
  createdAt: z.string().datetime(),
}).strict();

const EnrollmentChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  memberId: z.string().min(1).max(128),
  label: z.string().min(1).max(64),
  expiresAtMs: z.number().int().positive().safe(),
}).strict();

export interface DeviceIdentity {
  schemaVersion: 1;
  deviceId: string;
  deviceKeyId: string;
  publicKeyDer: string;
  privateKeyDer: string;
  createdAt: string;
}

export interface EnrollmentChallenge {
  challengeId: string;
  challenge: string;
  memberId: string;
  label: string;
  expiresAtMs: number;
}

export interface DeviceEnrollmentProof extends EnrollmentChallenge {
  deviceId: string;
  deviceKeyId: string;
  publicKeySpki: string;
  proofSignature: string;
}

function identityPath(root: string): string {
  return join(root, "device-identity-v1.json");
}

function decodeDer(value: string, expectedBytes: number): Buffer {
  const bytes = decodeBase64UrlBuffer(value);
  if (bytes.length !== expectedBytes || encodeBase64Url(bytes) !== value) {
    throw new Error(`invalid Ed25519 DER key; expected ${expectedBytes} canonical bytes`);
  }
  return bytes;
}

function validateKeyPair(identity: DeviceIdentity): void {
  const privateKey = createPrivateKey({ key: decodeDer(identity.privateKeyDer, ED25519_PKCS8_DER_BYTES), format: "der", type: "pkcs8" });
  const storedPublic = decodeDer(identity.publicKeyDer, ED25519_SPKI_DER_BYTES);
  const derivedPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  if (!storedPublic.equals(derivedPublic)) throw new Error("stored device public key does not match private key");
  const expectedKeyId = `device-${createHash("sha256").update(storedPublic).digest("hex").slice(0, 24)}`;
  if (identity.deviceKeyId !== expectedKeyId) throw new Error("stored device key ID does not match its public key");
}

export class DeviceIdentityStore {
  constructor(readonly root = join(homedir(), ".ccp", "identity")) {}

  loadOrCreate(): DeviceIdentity {
    const path = identityPath(this.root);
    const stored = readPrivateJson(path, 16 * 1024);
    if (stored !== undefined) {
      const identity = IdentitySchema.parse(stored) as DeviceIdentity;
      validateKeyPair(identity);
      return identity;
    }

    const pair = generateKeyPairSync("ed25519");
    const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
    const publicDer = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
    if (privateDer.byteLength !== ED25519_PKCS8_DER_BYTES || publicDer.byteLength !== ED25519_SPKI_DER_BYTES) {
      throw new Error("runtime produced an unexpected Ed25519 key encoding");
    }
    const identity: DeviceIdentity = {
      schemaVersion: 1,
      deviceId: randomUUID(),
      deviceKeyId: `device-${createHash("sha256").update(publicDer).digest("hex").slice(0, 24)}`,
      publicKeyDer: encodeBase64Url(publicDer),
      privateKeyDer: encodeBase64Url(privateDer),
      createdAt: new Date().toISOString(),
    };
    // Creation is successful only after the atomically written record can be read and verified.
    writePrivateJsonAtomic(path, identity);
    const persisted = IdentitySchema.parse(readPrivateJson(path, 16 * 1024)) as DeviceIdentity;
    validateKeyPair(persisted);
    if (persisted.deviceId !== identity.deviceId) throw new Error("persisted device identity changed during enrollment readiness");
    return persisted;
  }

  privateKey(identity: DeviceIdentity): KeyObject {
    validateKeyPair(identity);
    return createPrivateKey({ key: decodeDer(identity.privateKeyDer, ED25519_PKCS8_DER_BYTES), format: "der", type: "pkcs8" });
  }

  publicKey(identity: DeviceIdentity): KeyObject {
    validateKeyPair(identity);
    return createPublicKey({ key: decodeDer(identity.publicKeyDer, ED25519_SPKI_DER_BYTES), format: "der", type: "spki" });
  }

  createEnrollmentProof(identity: DeviceIdentity, challengeInput: unknown, nowMs = Date.now()): DeviceEnrollmentProof {
    validateKeyPair(identity);
    const challenge = EnrollmentChallengeSchema.parse(challengeInput) as EnrollmentChallenge;
    const challengeBytes = decodeBase64UrlBuffer(challenge.challenge);
    if (challengeBytes.byteLength !== 32 || encodeBase64Url(challengeBytes) !== challenge.challenge) throw new Error("enrollment challenge must be 32 canonical bytes");
    if (challenge.expiresAtMs <= nowMs) throw new Error("enrollment challenge is expired");
    const body = {
      ...challenge,
      deviceId: identity.deviceId,
      deviceKeyId: identity.deviceKeyId,
      publicKeySpki: identity.publicKeyDer,
    };
    const signatureBase = canonicalizeToBytes({ domain: "ccp-device-enrollment-v1", ...body });
    return { ...body, proofSignature: encodeBase64Url(sign(null, signatureBase, this.privateKey(identity))) };
  }
}
