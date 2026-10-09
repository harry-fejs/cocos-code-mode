import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth.ts";
import { importReleaseTarget, publishRolloutPolicy } from "../../src/ccp/release-admin.ts";
import { signReleaseMetadata } from "../../src/ccp/release-metadata.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";

const admin: AuthContext = {
  member_id: "member-1",
  label: "fixture",
  jti: "jti-1",
  is_legacy: false,
  clearance: "restricted",
  products: ["ccp"],
  tokenAlg: "EdDSA",
  role: "admin",
  exp: 2_000_000_000,
};

const searcher: AuthContext = { ...admin, role: "searcher" };

function targetBody(sha256 = "a".repeat(64), releaseSequence = 1) {
  return {
    schemaVersion: 1,
    metadataVersion: 1,
    releaseSequence,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    package: {
      name: "ccp3x",
      version: `2.0.${releaseSequence}`,
      sha256,
      size: 100,
      url: "https://releases.example.test/ccp3x.zip",
      packageManifestSha256: "b".repeat(64),
      sbomSha256: "c".repeat(64),
      provenanceSha256: "d".repeat(64),
    },
    compatibility: {
      protocol: { min: 1, max: 1 },
      creator: ">=3.7.0",
      os: ["win32"],
      arch: ["x64"],
    },
  };
}

function policyBody(targetHash: string, sequence = 1, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    policySequence: sequence,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    targetPayloadSha256: targetHash,
    channel: "stable",
    ring: "1",
    percentage: 100,
    recommended: true,
    blockedBuilds: [],
    rollbackTargetPayloadSha256: [],
    disabledOperations: [],
    emergencyStop: false,
    ...overrides,
  };
}

describe("CCP release admin", () => {
  const targetKeys = generateKeyPairSync("ed25519");
  const policyKeys = generateKeyPairSync("ed25519");
  const keys = {
    targets: new Map([["targets-fixture-1", targetKeys.publicKey]]),
    targetsThreshold: 1,
    policy: new Map([["policy-fixture-1", policyKeys.publicKey]]),
    policyThreshold: 1,
  };
  const targetPrivateKey = targetKeys.privateKey;
  const policyPrivateKey = policyKeys.privateKey;

  it("imports a signed target and publishes a signed policy referencing it", () => {
    const store = new CcBridgeStore(":memory:");
    const targetHash = "a".repeat(64);
    const imported = importReleaseTarget(store, admin, signReleaseMetadata("target", "targets-fixture-1", targetBody(targetHash), targetPrivateKey), keys);
    expect(imported.packageHash).toBe(targetHash);
    expect(store.listReleaseTargets()).toHaveLength(1);

    const published = publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 1), policyPrivateKey), keys);
    expect(published.policySequence).toBe(1);
    expect(store.listRolloutPolicies()).toHaveLength(1);
  });

  it("promotes an immutable target only through healthy, soaked rings 1 then 3 then 10", () => {
    const store = new CcBridgeStore(":memory:");
    const targetHash = "a".repeat(64);
    const imported = importReleaseTarget(store, admin, signReleaseMetadata("target", "targets-fixture-1", targetBody(targetHash), targetPrivateKey), keys);
    publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 1), policyPrivateKey), keys);
    for (const [sequence, fromRing, toRing, requiredDevices] of [[2, "1", "3", 1], [3, "3", "10", 3]] as const) {
      const now = Date.now();
      store.db.prepare("UPDATE rollout_state SET updated_at_ms = ? WHERE channel = ?")
        .run(now - 20 * 60_000, "stable");
      for (let index = 0; index < requiredDevices; index += 1) {
        store.recordCanaryHealth({
          targetHash: imported.targetPayloadHash, packageHash: targetHash, deviceId: `device-${index}`,
          probeId: `probe-${sequence}-${index}`, observedAtMs: now - 1000, ring: fromRing, healthy: true,
        });
      }
      publishRolloutPolicy(
        store,
        admin,
        signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, sequence, { ring: toRing }), policyPrivateKey),
        keys,
      );
    }
    expect(store.getRolloutState("stable")?.ring).toBe("10");
  });

  it("rejects direct ring 10, backward movement, and promotion without healthy evidence", () => {
    const store = new CcBridgeStore(":memory:");
    const imported = importReleaseTarget(store, admin, signReleaseMetadata("target", "targets-fixture-1", targetBody(), targetPrivateKey), keys);
    expect(() => publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 1, { ring: "10" }), policyPrivateKey), keys)).toThrow(/begin in canary ring 1/);
    publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 1), policyPrivateKey), keys);
    store.db.prepare("UPDATE rollout_state SET updated_at_ms = ? WHERE channel = ?")
      .run(Date.now() - 20 * 60_000, "stable");
    expect(() => publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 2, { ring: "10" }), policyPrivateKey), keys)).toThrow(/1→3→10/);
    store.recordCanaryHealth({
      targetHash: imported.targetPayloadHash, packageHash: "a".repeat(64), deviceId: "device-1",
      probeId: "probe-1", observedAtMs: Date.now(), ring: "1", healthy: true,
    });
    publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 2, { ring: "3" }), policyPrivateKey), keys);
    expect(() => publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 3, { ring: "1" }), policyPrivateKey), keys)).toThrow(/cannot move backward/);
    store.db.prepare("UPDATE rollout_state SET updated_at_ms = ? WHERE channel = ?")
      .run(Date.now() - 20 * 60_000, "stable");
    store.recordCanaryHealth({
      targetHash: imported.targetPayloadHash, packageHash: "a".repeat(64), deviceId: "device-bad",
      probeId: "probe-bad", observedAtMs: Date.now(), ring: "3", healthy: false,
    });
    expect(() => publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 4, { ring: "10" }), policyPrivateKey), keys)).toThrow(/unhealthy/);
  });

  it("stops a failed canary with a higher-sequence emergency policy", () => {
    const store = new CcBridgeStore(":memory:");
    const targetHash = "a".repeat(64);
    const imported = importReleaseTarget(store, admin, signReleaseMetadata("target", "targets-fixture-1", targetBody(targetHash), targetPrivateKey), keys);
    publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 1, { ring: "1" }), policyPrivateKey), keys);
    const stopped = publishRolloutPolicy(
      store,
      admin,
      signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 2, {
        ring: "1",
        emergencyStop: true,
        blockedBuilds: ["2.0.0-dev.bad"],
        disabledOperations: ["createUiNode"],
      }), policyPrivateKey),
      keys,
    );
    expect(stopped.policySequence).toBe(2);
    expect(store.listRolloutPolicies()[0]?.sequence).toBe(2);
  });

  it("rejects a policy with a non-increasing sequence", () => {
    const store = new CcBridgeStore(":memory:");
    const targetHash = "a".repeat(64);
    const imported = importReleaseTarget(store, admin, signReleaseMetadata("target", "targets-fixture-1", targetBody(targetHash), targetPrivateKey), keys);
    publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 5), policyPrivateKey), keys);
    expect(() => publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 5), policyPrivateKey), keys)).toThrow(/monotonically/);
    expect(() => publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody(imported.targetPayloadHash, 3), policyPrivateKey), keys)).toThrow(/monotonically/);
  });

  it("rejects a policy referencing an unknown target", () => {
    const store = new CcBridgeStore(":memory:");
    expect(() => publishRolloutPolicy(store, admin, signReleaseMetadata("policy", "policy-fixture-1", policyBody("c".repeat(64), 1), policyPrivateKey), keys)).toThrow(/unknown release target/);
  });

  it("rejects a target signed by the wrong key role", () => {
    const store = new CcBridgeStore(":memory:");
    // Signed with the policy key over the target domain -> targets threshold not met.
    expect(() => importReleaseTarget(store, admin, signReleaseMetadata("target", "policy-fixture-1", targetBody(), policyPrivateKey), keys)).toThrow();
  });

  it("rejects non-admin mutation", () => {
    const store = new CcBridgeStore(":memory:");
    expect(() => importReleaseTarget(store, searcher, signReleaseMetadata("target", "targets-fixture-1", targetBody(), targetPrivateKey), keys)).toThrow(/admin/);
  });

  it("rejects lower and equal target sequences with typed replay before insertion", () => {
    const store = new CcBridgeStore(":memory:");
    importReleaseTarget(store, admin, signReleaseMetadata("target", "targets-fixture-1", targetBody("a".repeat(64), 4), targetPrivateKey), keys);
    for (const sequence of [4, 3]) {
      try {
        importReleaseTarget(store, admin, signReleaseMetadata("target", "targets-fixture-1", targetBody(String(sequence).repeat(64).slice(0, 64), sequence), targetPrivateKey), keys);
        throw new Error("expected replay denial");
      } catch (error) {
        expect((error as { body?: { code?: string } }).body?.code).toBe("CCP_REPLAY");
      }
    }
    expect(store.listReleaseTargets()).toHaveLength(1);
  });
});
