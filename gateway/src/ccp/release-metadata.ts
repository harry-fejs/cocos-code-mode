import { KeyLike, sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";
import { canonicalizeToBytes, IJson, parseCanonicalJson } from "./canonical-json.ts";
import { ED25519_SIGNATURE_BYTES, assertKeyId, decodeBase64Url, encodeBase64Url } from "./protocol.ts";

export interface MetadataSignature {
  keyId: string;
  signature: string;
}

export interface SignedMetadata {
  payload: string;
  signatures: MetadataSignature[];
}

const ROOT_PREFIX = Buffer.from("CCP1 release-root\n", "utf8");
const TARGET_PREFIX = Buffer.from("CCP1 release-targets\n", "utf8");
const POLICY_PREFIX = Buffer.from("CCP1 rollout-policy\n", "utf8");

function signatureBase(prefix: Buffer, payload: Uint8Array): Buffer {
  return Buffer.concat([prefix, payload]);
}

export function signReleaseMetadata(
  kind: "root" | "target" | "policy",
  keyId: string,
  body: unknown,
  privateKey: KeyLike,
): SignedMetadata {
  assertKeyId(keyId);
  const payload = canonicalizeToBytes(body);
  const prefix = kind === "root" ? ROOT_PREFIX : kind === "target" ? TARGET_PREFIX : POLICY_PREFIX;
  const signature = encodeBase64Url(ed25519Sign(null, signatureBase(prefix, payload), privateKey));
  return { payload: encodeBase64Url(payload), signatures: [{ keyId, signature }] };
}

export function verifyReleaseMetadata(
  kind: "root" | "target" | "policy",
  wrapper: SignedMetadata,
  keys: ReadonlyMap<string, KeyLike>,
  threshold: number,
): IJson {
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > keys.size) {
    throw new Error("release metadata signature threshold is invalid");
  }
  if (
    !wrapper || typeof wrapper !== "object"
    || typeof wrapper.payload !== "string"
    || !Array.isArray(wrapper.signatures)
    || wrapper.signatures.length < 1
    || wrapper.signatures.length > 16
  ) {
    throw new Error("release metadata wrapper is invalid");
  }
  const payload = decodeBase64Url(wrapper.payload, 256 * 1024);
  const prefix = kind === "root" ? ROOT_PREFIX : kind === "target" ? TARGET_PREFIX : POLICY_PREFIX;
  const message = signatureBase(prefix, payload);
  const seen = new Set<string>();
  let accepted = 0;
  for (const entry of wrapper.signatures) {
    if (!entry || typeof entry !== "object" || typeof entry.keyId !== "string" || typeof entry.signature !== "string") {
      throw new Error("release metadata signature entry is invalid");
    }
    assertKeyId(entry.keyId);
    if (seen.has(entry.keyId)) throw new Error("release metadata contains a duplicate signer");
    seen.add(entry.keyId);
    const key = keys.get(entry.keyId);
    if (!key) throw new Error("release metadata contains an unknown signer");
    const signature = decodeBase64Url(entry.signature, ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BYTES);
    if (!ed25519Verify(null, message, key, signature)) throw new Error("release metadata signature is invalid");
    accepted += 1;
  }
  if (accepted < threshold) throw new Error("release metadata signature threshold not met");
  return parseCanonicalJson(payload, 256 * 1024);
}
