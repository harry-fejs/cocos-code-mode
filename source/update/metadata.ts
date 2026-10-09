import { verify as ed25519Verify } from "crypto"
import type { KeyLike } from "crypto"
import { z } from "zod";
import { parseCanonicalJson } from "../protected/canonical-json";
import { CcpError } from "../protected/errors";
import { ED25519_SIGNATURE_BYTES, assertKeyId, decodeBase64Url } from "../protected/protocol";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const IsoSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "must be an exact ISO timestamp");
const KeyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

const SignatureSchema = z.object({
  keyId: KeyIdSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export const SignedMetadataSchema = z.object({
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/),
  signatures: z.array(SignatureSchema).min(1).max(16),
}).strict();
export type SignedMetadata = z.infer<typeof SignedMetadataSchema>;

const RoleSchema = z.object({ keyIds: z.array(KeyIdSchema).min(1), threshold: z.number().int().positive() }).strict();
export const RootBodySchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal("ccp3x"),
  rootVersion: z.number().int().positive(),
  issuedAt: IsoSchema,
  expiresAt: IsoSchema,
  keys: z.record(z.object({ algorithm: z.literal("Ed25519"), spkiDer: z.string().regex(/^[A-Za-z0-9_-]+$/) }).strict()),
  roles: z.object({ root: RoleSchema, targets: RoleSchema, policy: RoleSchema }).strict(),
}).strict();
export type RootBody = z.infer<typeof RootBodySchema>;

export const ReleaseTargetBodySchema = z.object({
  schemaVersion: z.literal(1),
  metadataVersion: z.number().int().positive(),
  releaseSequence: z.number().int().positive(),
  issuedAt: IsoSchema,
  expiresAt: IsoSchema,
  package: z.object({
    name: z.literal("ccp3x"),
    version: z.string().min(1).max(128),
    sha256: Sha256Schema,
    size: z.number().int().positive().safe(),
    url: z.string().url().refine((value) => value.startsWith("https://"), "must use HTTPS"),
    packageManifestSha256: Sha256Schema,
    sbomSha256: Sha256Schema,
    provenanceSha256: Sha256Schema,
  }).strict(),
  compatibility: z.object({
    protocol: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).strict(),
    creator: z.string().min(1).max(128),
    os: z.array(z.string().min(1).max(32)).min(1).max(16),
    arch: z.array(z.string().min(1).max(32)).min(1).max(16),
  }).strict(),
}).strict();
export type ReleaseTargetBody = z.infer<typeof ReleaseTargetBodySchema>;

export const RolloutPolicyBodySchema = z.object({
  schemaVersion: z.literal(1),
  policySequence: z.number().int().positive(),
  issuedAt: IsoSchema,
  expiresAt: IsoSchema,
  targetPayloadSha256: Sha256Schema,
  channel: z.string().min(1).max(64),
  ring: z.enum(["1", "3", "10"]),
  percentage: z.number().int().min(0).max(100),
  recommended: z.boolean(),
  minimumBuild: z.string().min(1).max(128).optional(),
  blockedBuilds: z.array(z.string().min(1).max(128)).max(1024),
  rollbackTargetPayloadSha256: z.array(Sha256Schema).max(8),
  disabledOperations: z.array(z.string().min(1).max(128)).max(1024),
  emergencyStop: z.boolean(),
}).strict();
export type RolloutPolicyBody = z.infer<typeof RolloutPolicyBodySchema>;

const PREFIX = {
  root: Buffer.from("CCP1 release-root\n", "utf8"),
  target: Buffer.from("CCP1 release-targets\n", "utf8"),
  policy: Buffer.from("CCP1 rollout-policy\n", "utf8"),
} as const;
const BODY_SCHEMA = { root: RootBodySchema, target: ReleaseTargetBodySchema, policy: RolloutPolicyBodySchema } as const;
export type ReleaseMetadataKind = keyof typeof PREFIX;
export type ReleaseMetadataBody<K extends ReleaseMetadataKind> = K extends "root" ? RootBody : K extends "target" ? ReleaseTargetBody : RolloutPolicyBody;

function fail(code: "CCP_CANONICAL_INVALID" | "CCP_SIGNATURE_INVALID", message: string): never {
  throw new CcpError(code, message);
}

interface DecodedMetadata<K extends ReleaseMetadataKind> {
  wrapper: SignedMetadata;
  message: Buffer;
  body: ReleaseMetadataBody<K>;
}

export interface ReleaseSignatureRole {
  label: string;
  keys: ReadonlyMap<string, KeyLike>;
  threshold: number;
}

function decodeMetadata<K extends ReleaseMetadataKind>(kind: K, input: unknown): DecodedMetadata<K> {
  let wrapper: SignedMetadata;
  try { wrapper = SignedMetadataSchema.parse(input); }
  catch { fail("CCP_CANONICAL_INVALID", "Release metadata wrapper is invalid."); }
  let payload: Buffer;
  try { payload = decodeBase64Url(wrapper.payload, 256 * 1024); }
  catch { fail("CCP_CANONICAL_INVALID", "Release metadata payload encoding is invalid."); }
  let parsed: unknown;
  try { parsed = parseCanonicalJson(payload, 256 * 1024); }
  catch { fail("CCP_CANONICAL_INVALID", "Release metadata payload is not canonical RFC 8785 I-JSON."); }
  let body: ReleaseMetadataBody<K>;
  try { body = BODY_SCHEMA[kind].parse(parsed) as ReleaseMetadataBody<K>; }
  catch { fail("CCP_CANONICAL_INVALID", `Release ${kind} metadata body is invalid.`); }
  return { wrapper, message: Buffer.concat([PREFIX[kind], payload]), body };
}

export function parseUntrustedReleaseMetadataBody<K extends ReleaseMetadataKind>(
  kind: K,
  input: unknown,
): ReleaseMetadataBody<K> {
  return decodeMetadata(kind, input).body;
}

export function verifyReleaseMetadataForRoles<K extends ReleaseMetadataKind>(
  kind: K,
  input: unknown,
  roles: readonly ReleaseSignatureRole[],
): ReleaseMetadataBody<K> {
  if (roles.length === 0) fail("CCP_SIGNATURE_INVALID", "Release metadata has no authorized signature roles.");
  for (const role of roles) {
    if (!Number.isSafeInteger(role.threshold) || role.threshold < 1 || role.threshold > role.keys.size) {
      fail("CCP_SIGNATURE_INVALID", `Release metadata ${role.label} signature threshold is invalid.`);
    }
  }
  const decoded = decodeMetadata(kind, input);
  const seen = new Set<string>();
  const acceptedByRole = roles.map(() => 0);
  for (const entry of decoded.wrapper.signatures) {
    try { assertKeyId(entry.keyId); }
    catch { fail("CCP_CANONICAL_INVALID", "Release metadata key ID is invalid."); }
    if (seen.has(entry.keyId)) fail("CCP_SIGNATURE_INVALID", "Release metadata contains a duplicate signature key.");
    seen.add(entry.keyId);
    let signature: Buffer;
    try { signature = decodeBase64Url(entry.signature, ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BYTES); }
    catch { fail("CCP_SIGNATURE_INVALID", "Release metadata signature encoding is invalid."); }
    let recognized = false;
    let valid = false;
    roles.forEach((role, index) => {
      const key = role.keys.get(entry.keyId);
      if (!key) return;
      recognized = true;
      if (ed25519Verify(null, decoded.message, key, signature)) {
        acceptedByRole[index] += 1;
        valid = true;
      }
    });
    if (!recognized) fail("CCP_SIGNATURE_INVALID", "Release metadata contains an unknown signature key.");
    if (!valid) fail("CCP_SIGNATURE_INVALID", "Release metadata signature is invalid.");
  }
  roles.forEach((role, index) => {
    if (acceptedByRole[index] < role.threshold) {
      fail("CCP_SIGNATURE_INVALID", `Release metadata ${role.label} signature threshold not met.`);
    }
  });
  return decoded.body;
}

export function verifyReleaseMetadata<K extends ReleaseMetadataKind>(
  kind: K,
  input: unknown,
  keys: ReadonlyMap<string, KeyLike>,
  threshold: number,
): ReleaseMetadataBody<K> {
  return verifyReleaseMetadataForRoles(kind, input, [{ label: kind, keys, threshold }]);
}
