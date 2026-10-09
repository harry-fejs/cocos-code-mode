import type { KeyLike } from "node:crypto";
import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import type { AuthContext } from "../auth.ts";
import { CcpError } from "./errors.ts";
import { verifyReleaseMetadata, type SignedMetadata } from "./release-metadata.ts";
import { assertDurableCanaryPromotion } from "./canary.ts";
import type { CcBridgeStore } from "./store.ts";
import { persistSignedExecutionControls } from "./rollout-enforcement.ts";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IsoSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "must be an exact ISO timestamp");

const ReleaseTargetBodySchema = z.object({
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

const RolloutPolicyBodySchema = z.object({
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

export interface ReleaseKeySet {
  targets: ReadonlyMap<string, KeyLike>;
  targetsThreshold: number;
  policy: ReadonlyMap<string, KeyLike>;
  policyThreshold: number;
}

export function loadReleaseKeySet(env: NodeJS.ProcessEnv = process.env): ReleaseKeySet | null {
  const targetsPem = env.CCP_RELEASE_TARGETS_PUBLIC_KEY_PEM;
  const policyPem = env.CCP_RELEASE_POLICY_PUBLIC_KEY_PEM;
  if (!targetsPem || !policyPem) return null;
  const targetsThreshold = Number(env.CCP_RELEASE_TARGETS_THRESHOLD ?? "1");
  const policyThreshold = Number(env.CCP_RELEASE_POLICY_THRESHOLD ?? "1");
  if (!Number.isSafeInteger(targetsThreshold) || targetsThreshold < 1 || !Number.isSafeInteger(policyThreshold) || policyThreshold < 1) {
    throw new Error("release key thresholds must be positive integers");
  }
  return {
    targets: new Map([[env.CCP_RELEASE_TARGETS_KEY_ID ?? "release-targets", createPublicKey(targetsPem)]]),
    targetsThreshold,
    policy: new Map([[env.CCP_RELEASE_POLICY_KEY_ID ?? "rollout-policy", createPublicKey(policyPem)]]),
    policyThreshold,
  };
}

function requireAdmin(auth: AuthContext): void {
  if (auth.role !== "admin") throw new CcpError("CCP_AUTH_INVALID", "Only an admin can manage releases.");
}

export function importReleaseTarget(store: CcBridgeStore, auth: AuthContext, wrapper: SignedMetadata, keys: ReleaseKeySet): { sequence: number; version: string; packageHash: string; targetPayloadHash: string } {
  requireAdmin(auth);
  const body = ReleaseTargetBodySchema.parse(verifyReleaseMetadata("target", wrapper, keys.targets, keys.targetsThreshold));
  const targetPayloadHash = createHash("sha256").update(Buffer.from(wrapper.payload, "base64url")).digest("hex");
  if (Date.parse(body.issuedAt) > Date.now() || Date.parse(body.expiresAt) <= Date.now()) {
    throw new CcpError("CCP_CANONICAL_INVALID", "Release target metadata is not currently valid.");
  }
  const latest = store.latestReleaseTargetSequence();
  if (body.releaseSequence <= latest) {
    throw new CcpError("CCP_REPLAY", "Release target sequence must increase monotonically.", { latest, submitted: body.releaseSequence });
  }
  const existing = store.getReleaseTargetByHash(body.package.sha256);
  if (existing) throw new CcpError("CCP_REPLAY", "A release target with this package hash already exists.");
  const sequence = store.insertReleaseTarget({
    sequence: body.releaseSequence,
    version: body.package.version,
    packageHash: body.package.sha256,
    targetPayloadHash,
    compatibility: body.compatibility,
    status: "active",
  });
  return { sequence, version: body.package.version, packageHash: body.package.sha256, targetPayloadHash };
}

export function publishRolloutPolicy(store: CcBridgeStore, auth: AuthContext, wrapper: SignedMetadata, keys: ReleaseKeySet): { sequence: number; policySequence: number } {
  requireAdmin(auth);
  const body = RolloutPolicyBodySchema.parse(verifyReleaseMetadata("policy", wrapper, keys.policy, keys.policyThreshold));
  if (Date.parse(body.issuedAt) > Date.now() || Date.parse(body.expiresAt) <= Date.now()) {
    throw new CcpError("CCP_CANONICAL_INVALID", "Rollout policy metadata is not currently valid.");
  }
  const latest = store.latestRolloutPolicySequence();
  if (body.policySequence <= latest) {
    throw new CcpError("CCP_REPLAY", "Rollout policy sequence must increase monotonically.", { latest, submitted: body.policySequence });
  }
  const rolloutHighWater = store.getRolloutState(body.channel);
  if (rolloutHighWater && body.policySequence <= rolloutHighWater.policySequence) {
    throw new CcpError("CCP_REPLAY", "Rollout state policy sequence must increase monotonically.", {
      latest: rolloutHighWater.policySequence,
      submitted: body.policySequence,
    });
  }
  const target = store.getReleaseTargetByPayloadHash(body.targetPayloadSha256);
  if (!target) {
    throw new CcpError("CCP_DEVICE_DENIED", "Rollout policy references an unknown release target.");
  }
  const nowMs = Date.now();
  if (!body.emergencyStop) {
    assertDurableCanaryPromotion(store, {
      channel: body.channel,
      targetHash: body.targetPayloadSha256,
      packageHash: target.packageHash,
      ring: body.ring,
      policySequence: body.policySequence,
      nowMs,
    });
  }
  return store.db.transaction(() => {
    const sequence = store.insertRolloutPolicy({
      sequence: body.policySequence,
      targetHash: body.targetPayloadSha256,
      channel: body.channel,
      ring: body.ring,
      percentage: body.percentage,
      minimumBuild: body.minimumBuild ?? null,
      blockedBuilds: body.blockedBuilds,
      rollbackTargetHash: body.rollbackTargetPayloadSha256[0] ?? null,
      expiresAtMs: Date.parse(body.expiresAt),
    });
    persistSignedExecutionControls(store, body, wrapper);
    const previous = store.getRolloutState(body.channel);
    if (!store.setRolloutState({
      channel: body.channel,
      targetHash: body.emergencyStop && previous ? previous.targetHash : body.targetPayloadSha256,
      packageHash: body.emergencyStop && previous ? previous.packageHash : target.packageHash,
      ring: body.emergencyStop && previous ? previous.ring : body.ring,
      policySequence: body.policySequence,
      updatedAtMs: nowMs,
    })) {
      throw new CcpError("CCP_REPLAY", "Rollout state high-water rejected the policy sequence.");
    }
    return { sequence, policySequence: body.policySequence };
  })();
}
