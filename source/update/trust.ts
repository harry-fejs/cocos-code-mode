import { createHash, createPublicKey } from "crypto"
import type { KeyLike } from "crypto"
import { CcpError } from "../protected/errors";
import { decodeBase64Url } from "../protected/protocol";
import {
  ReleaseTargetBody,
  RolloutPolicyBody,
  RootBody,
  SignedMetadata,
  parseUntrustedReleaseMetadataBody,
  verifyReleaseMetadata,
  verifyReleaseMetadataForRoles,
} from "./metadata";
import { satisfiesSemverRange } from "./semver-range";
import { UpdateState, UpdateStateStore } from "./state";

export interface UpdateCompatibility {
  protocolVersion: number;
  creatorVersion: string;
  os: string;
  arch: string;
  currentBuild: string;
  deviceId: string;
  channel: string;
  allowedRing: "1" | "3" | "10";
}

export interface AcceptedRelease {
  root: RootBody;
  target: ReleaseTargetBody;
  policy: RolloutPolicyBody;
  targetPayloadSha256: string;
  state: UpdateState;
}

function payloadDigest(wrapper: SignedMetadata): string {
  return createHash("sha256").update(decodeBase64Url(wrapper.payload, 256 * 1024)).digest("hex");
}

function activeAt(issuedAt: string, expiresAt: string, nowMs: number, label: string): void {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > nowMs || expires <= nowMs || expires <= issued) {
    throw new CcpError(issued > nowMs || expires <= issued ? "CCP_CANONICAL_INVALID" : "CCP_EXPIRED", `${label} metadata is not currently valid.`);
  }
}

function roleKeys(root: RootBody, role: keyof RootBody["roles"]): { keys: ReadonlyMap<string, KeyLike>; threshold: number } {
  const definition = root.roles[role];
  const unique = new Set(definition.keyIds);
  if (unique.size !== definition.keyIds.length || definition.threshold > unique.size) {
    throw new CcpError("CCP_CANONICAL_INVALID", `Root ${role} role is invalid.`);
  }
  const keys = new Map<string, KeyLike>();
  for (const keyId of definition.keyIds) {
    const definitionForKey = root.keys[keyId];
    if (!definitionForKey) throw new CcpError("CCP_CANONICAL_INVALID", `Root ${role} role references an unknown key.`);
    try {
      const der = decodeBase64Url(definitionForKey.spkiDer, 44, 44);
      keys.set(keyId, createPublicKey({ key: der, format: "der", type: "spki" }));
    } catch {
      throw new CcpError("CCP_CANONICAL_INVALID", `Root ${role} key is not a valid Ed25519 SPKI key.`);
    }
  }
  return { keys, threshold: definition.threshold };
}


function ringRank(ring: "1" | "3" | "10"): number {
  return ring === "1" ? 1 : ring === "3" ? 3 : 10;
}

function selectedForPercentage(deviceId: string, percentage: number): boolean {
  if (percentage === 100) return true;
  if (percentage === 0) return false;
  const bucket = createHash("sha256").update(deviceId, "utf8").digest().readUInt32BE(0) % 100;
  return bucket < percentage;
}

export function acceptRootRotation(current: RootBody, candidateWrapper: SignedMetadata, nowMs = Date.now()): RootBody {
  activeAt(current.issuedAt, current.expiresAt, nowMs, "Trusted root");
  const candidate = parseUntrustedReleaseMetadataBody("root", candidateWrapper);
  const currentRole = roleKeys(current, "root");
  const candidateRole = roleKeys(candidate, "root");
  verifyReleaseMetadataForRoles("root", candidateWrapper, [
    { label: "current-root", ...currentRole },
    { label: "candidate-root", ...candidateRole },
  ]);
  if (candidate.rootVersion <= current.rootVersion) throw new CcpError("CCP_REPLAY", "Root version must increase.");
  activeAt(candidate.issuedAt, candidate.expiresAt, nowMs, "Candidate root");
  return candidate;
}

export function acceptRelease(
  root: RootBody,
  targetWrapper: SignedMetadata,
  policyWrapper: SignedMetadata,
  compatibility: UpdateCompatibility,
  stateStore: UpdateStateStore,
  nowMs = Date.now(),
): AcceptedRelease {
  activeAt(root.issuedAt, root.expiresAt, nowMs, "Root");
  const targetRole = roleKeys(root, "targets");
  const policyRole = roleKeys(root, "policy");
  const target = verifyReleaseMetadata("target", targetWrapper, targetRole.keys, targetRole.threshold);
  const policy = verifyReleaseMetadata("policy", policyWrapper, policyRole.keys, policyRole.threshold);
  activeAt(target.issuedAt, target.expiresAt, nowMs, "Release target");
  activeAt(policy.issuedAt, policy.expiresAt, nowMs, "Rollout policy");

  const targetPayloadSha256 = payloadDigest(targetWrapper);
  const policyPayloadSha256 = payloadDigest(policyWrapper);
  if (policy.targetPayloadSha256 !== targetPayloadSha256) throw new CcpError("CCP_SIGNATURE_INVALID", "Rollout policy targets different signed target bytes.");
  if (policy.channel !== compatibility.channel) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Rollout policy channel does not match this relay.");
  const current = stateStore.load();
  if (policy.emergencyStop) {
    stateStore.persistIfMonotonic({
      ...current,
      highestRootVersion: root.rootVersion,
      highestTargetSequence: target.releaseSequence,
      highestPolicySequence: policy.policySequence,
      targetPayloadSha256,
      policyPayloadSha256,
      channel: policy.channel,
      ring: policy.ring,
    });
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Rollout policy emergency stop is active.");
  }
  if (ringRank(policy.ring) > ringRank(compatibility.allowedRing) || !selectedForPercentage(compatibility.deviceId, policy.percentage)) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "This device is not selected for the rollout ring.");
  }
  if (policy.blockedBuilds.includes(compatibility.currentBuild)) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Current relay build is blocked.");
  if (policy.minimumBuild && !satisfiesSemverRange(compatibility.currentBuild, `>=${policy.minimumBuild}`)) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Current relay build is below the policy minimum.");
  }
  if (compatibility.protocolVersion < target.compatibility.protocol.min || compatibility.protocolVersion > target.compatibility.protocol.max) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Release target protocol range is incompatible.");
  }
  if (!target.compatibility.os.includes(compatibility.os) || !target.compatibility.arch.includes(compatibility.arch)) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Release target platform is incompatible.");
  }
  if (!satisfiesSemverRange(compatibility.creatorVersion, target.compatibility.creator)) {
    throw new CcpError("CCP_CREATOR_INCOMPATIBLE", "Release target Creator range is incompatible.");
  }
  const rollbackTargetPayloadSha256 = current.activeTargetPayloadSha256
    && policy.rollbackTargetPayloadSha256.includes(current.activeTargetPayloadSha256)
    ? current.activeTargetPayloadSha256
    : undefined;
  if (current.activeTargetPayloadSha256 && !rollbackTargetPayloadSha256) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Rollout policy does not permit health rollback to the active release.");
  }
  const next = stateStore.persistIfMonotonic({
    ...current,
    highestRootVersion: root.rootVersion,
    highestTargetSequence: target.releaseSequence,
    highestPolicySequence: policy.policySequence,
    rootPayloadSha256: current.rootPayloadSha256,
    targetPayloadSha256,
    policyPayloadSha256,
    channel: policy.channel,
    ring: policy.ring,
    rollbackTargetPayloadSha256,
  });
  return { root, target, policy, targetPayloadSha256, state: next };
}
