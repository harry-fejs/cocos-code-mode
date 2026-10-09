import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { CANARY_MIN_SOAK_MS, recordVerifiedCanaryHealth } from "../../src/ccp/canary.ts";
import { importReleaseTarget, publishRolloutPolicy } from "../../src/ccp/release-admin.ts";
import { signReleaseMetadata } from "../../src/ccp/release-metadata.ts";
import { verifyReleaseMetadata, type RootBody, type RolloutPolicyBody } from "../../../source/update/metadata.ts";
import { acceptRelease } from "../../../source/update/trust.ts";
import { UpdateStateStore } from "../../../source/update/state.ts";
import { Evidence, delay, errorCode, invariant, sha256 } from "./local-qualification-evidence.ts";
import { QualificationRuntime } from "./local-qualification-runtime.ts";

export async function qualifyCanary(runtime: QualificationRuntime, evidence: Evidence): Promise<void> {
  const fixtureClock = process.env.CCP_QUAL_CANARY_CLOCK === "fixture";
  invariant(!process.env.CCP_QUAL_CANARY_CLOCK || ["fixture", "wall"].includes(process.env.CCP_QUAL_CANARY_CLOCK), "INVALID_CANARY_CLOCK");
  const rootKeys = generateKeyPairSync("ed25519");
  const targetKeys = generateKeyPairSync("ed25519");
  const policyKeys = generateKeyPairSync("ed25519");
  const keys = { targets: new Map([["qualification-target", targetKeys.publicKey]]), targetsThreshold: 1,
    policy: new Map([["qualification-policy", policyKeys.publicKey]]), policyThreshold: 1 };
  const times = { issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const rootBody: RootBody = { schemaVersion: 1, product: "ccp3x", rootVersion: 1, ...times,
    keys: {
      "qualification-root": { algorithm: "Ed25519", spkiDer: rootKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url") },
      "qualification-target": { algorithm: "Ed25519", spkiDer: targetKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url") },
      "qualification-policy": { algorithm: "Ed25519", spkiDer: policyKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url") },
    },
    roles: { root: { keyIds: ["qualification-root"], threshold: 1 }, targets: { keyIds: ["qualification-target"], threshold: 1 }, policy: { keyIds: ["qualification-policy"], threshold: 1 } } };
  const root = verifyReleaseMetadata("root", signReleaseMetadata("root", "qualification-root", rootBody, rootKeys.privateKey), new Map([["qualification-root", rootKeys.publicKey]]), 1);
  let target = signReleaseMetadata("target", "qualification-target", { schemaVersion: 1, metadataVersion: 1, releaseSequence: 1, ...times,
    package: { name: "ccp3x", version: "2.0.1-local-qualification", sha256: sha256("metadata-only-no-ZIP"), size: 1,
      url: "https://qualification.invalid/never-downloaded.zip", packageManifestSha256: sha256("no-manifest"), sbomSha256: sha256("no-sbom"), provenanceSha256: sha256("no-provenance") },
    compatibility: { protocol: { min: 1, max: 1 }, creator: ">=3.7.0 <3.9.0", os: ["win32"], arch: ["x64"] },
  }, targetKeys.privateKey);
  let imported = importReleaseTarget(runtime.store, runtime.clients[0].auth, target, keys);
  let sequence = 0;
  const states = runtime.clients.slice(0, 10).map((_, index) => new UpdateStateStore(join(runtime.directory, `client-${index}-update.json`)));
  const policy = (channel: string, ring: "1" | "3" | "10", overrides: Partial<RolloutPolicyBody> = {}) => signReleaseMetadata("policy", "qualification-policy", {
    schemaVersion: 1, policySequence: ++sequence, ...times, targetPayloadSha256: imported.targetPayloadHash, channel, ring,
    percentage: 100, recommended: true, blockedBuilds: [], rollbackTargetPayloadSha256: [], disabledOperations: [], emergencyStop: false, ...overrides,
  }, policyKeys.privateKey);
  const publish = (wrapper: typeof target) => publishRolloutPolicy(runtime.store, runtime.clients[0].auth, wrapper, keys);
  const accept = (wrapper: typeof target, channel: string, ring: "1" | "3" | "10", index: number) => acceptRelease(root, target, wrapper, {
    protocolVersion: 1, creatorVersion: "3.7.3", os: "win32", arch: "x64", currentBuild: runtime.clients[index].relay.build,
    deviceId: runtime.clients[index].deviceId, channel, allowedRing: ring,
  }, states[index]);
  const health = async (ring: "1" | "3" | "10", count: number) => {
    for (const client of runtime.clients.slice(0, count)) {
      const result = await runtime.call(client, `canary-ring-${ring}-simulated-probe`);
      invariant(result.nameHash === sha256("Qualification Named Node"), "CANARY_BEHAVIOR_MISMATCH");
      recordVerifiedCanaryHealth(runtime.store, { targetHash: imported.targetPayloadHash, packageHash: imported.packageHash,
        deviceId: client.deviceId, probeId: randomUUID(), observedAtMs: Date.now(), ring, healthy: true });
    }
  };
  const soak = async (channel: string, probe?: () => Promise<void>) => {
    if (fixtureClock) {
      runtime.store.db.prepare("UPDATE rollout_state SET updated_at_ms = ? WHERE channel = ?").run(Date.now() - CANARY_MIN_SOAK_MS - 1, channel);
      evidence.emit({ type: "clock-fixture", scenario: "canary", channel, elapsedSoakProof: false, seededAgeMs: CANARY_MIN_SOAK_MS + 1 });
      return;
    }
    const start = performance.now();
    while (performance.now() - start < CANARY_MIN_SOAK_MS + 10) {
      if (probe) await probe();
      await delay(Math.min(60_000, Math.max(1, CANARY_MIN_SOAK_MS + 10 - (performance.now() - start))));
    }
  };
  evidence.emit({ type: "configuration", scenario: "canary", clockMode: fixtureClock ? "explicit-isolated-timestamp-fixture" : "wall-clock",
    requiredRingSoakMs: CANARY_MIN_SOAK_MS, targetPayloadHash: imported.targetPayloadHash, packageHash: imported.packageHash,
    packageMaterial: "metadata-only-fixture-no-artifacts-no-download-no-stage-no-install", healthSurface: "real-protected-path-simulated-Creator" });
  await evidence.scenario("failed-ring1-no-promotion", async () => {
    publish(policy("failed-local", "1"));
    // Real device proof denial supplies the unhealthy probe; not invented health.
    const failedClient = runtime.clients[runtime.clients.length - 1];
    runtime.store.revokeDevice(failedClient.deviceId);
    await soak("failed-local");
    await runtime.call(failedClient, "canary-ring1-revoked-device", 422, "CCP_DEVICE_DENIED");
    recordVerifiedCanaryHealth(runtime.store, { targetHash: imported.targetPayloadHash, packageHash: imported.packageHash,
      deviceId: failedClient.deviceId, probeId: randomUUID(), observedAtMs: Date.now(), ring: "1", healthy: false });
    const before = runtime.store.latestRolloutPolicySequence();
    let denied = false;
    try { publish(policy("failed-local", "3")); } catch (error) { invariant(errorCode(error) === "CCP_DEVICE_DENIED", "WRONG_PROMOTION_DENIAL"); denied = true; }
    invariant(denied && runtime.store.getRolloutState("failed-local")?.ring === "1" && runtime.store.latestRolloutPolicySequence() === before, "FAILED_CANARY_PROMOTED");
    return { ring: "1", deniedPromotion: "3", elapsedSoakProof: !fixtureClock, failureSource: "revoked-device-protected-call" };
  });
  await evidence.scenario("healthy-signed-1-3-10", async () => {
    // Failure evidence is release-wide: use a distinct immutable target for a
    // healthy rehearsal rather than deleting a failed probe to obtain promotion.
    const healthyBody = JSON.parse(Buffer.from(target.payload, "base64url").toString("utf8"));
    healthyBody.releaseSequence = 2; healthyBody.package.version = "2.0.2-local-qualification";
    healthyBody.package.sha256 = runtime.clients[0].relay.packageHash;
    const healthyTarget = signReleaseMetadata("target", "qualification-target", healthyBody, targetKeys.privateKey);
    const healthyImport = importReleaseTarget(runtime.store, runtime.clients[0].auth, healthyTarget, keys);
    // Switch candidates once; each candidate's signed bytes remain immutable.
    target = healthyTarget; imported = healthyImport;
    for (const [ring, count] of [["1", 1], ["3", 3], ["10", 10]] as const) {
      const previousRing = ring === "1" ? undefined : ring === "3" ? "1" : "3";
      if (previousRing) await soak("healthy-local", () => health(previousRing, Number(previousRing)));
      const wrapper = policy("healthy-local", ring); const published = publish(wrapper);
      for (let index = 0; index < count; index += 1) {
        const accepted = accept(wrapper, "healthy-local", ring, index);
        invariant(accepted.state.highestPolicySequence === published.policySequence, "UPDATER_POLICY_HIGHWATER_MISMATCH");
      }
      await health(ring, count);
      evidence.emit({ type: "canary-ring", scenario: "healthy-signed-1-3-10", ring, policySequence: published.policySequence,
        targetPayloadHash: imported.targetPayloadHash, acceptedClients: count, packageDownloads: 0, installations: 0 });
    }
    invariant(runtime.store.getRolloutState("healthy-local")?.ring === "10", "HEALTHY_RING10_NOT_REACHED");
    return { ring: "10", clients: 10, elapsedSoakProof: !fixtureClock, targetPayloadHash: imported.targetPayloadHash };
  });
  await evidence.scenario("signed-emergency-updater-stop", async () => {
    const wrapper = policy("healthy-local", "10", { emergencyStop: true, disabledOperations: ["createUiNode"] });
    const published = publish(wrapper);
    for (let index = 0; index < 10; index += 1) {
      let denied = false;
      try { accept(wrapper, "healthy-local", "10", index); } catch (error) { invariant(errorCode(error) === "CCP_BUILD_INCOMPATIBLE", "WRONG_EMERGENCY_DENIAL"); denied = true; }
      invariant(denied && states[index].load().highestPolicySequence === published.policySequence, "EMERGENCY_POLICY_NOT_PERSISTED");
    }
    return { deniedClients: 10, policySequence: published.policySequence, activationAttempted: false };
  });
  await evidence.scenario("signed-emergency-protected-operation-stop", async () => {
    await runtime.restart();
    await runtime.call(runtime.clients[0], "signed-emergency-protected-operation-stop", 422, "CCP_GATEWAY_UNAVAILABLE");
    return { actualCreatorIpc: 0, gate: "signed-rollout-policy" };
  });
  await evidence.scenario("signed-disabled-operation-stop", async () => {
    publish(policy("healthy-local", "10", { disabledOperations: ["createUiNode"] }));
    await runtime.call(runtime.clients[0], "signed-disabled-operation-stop", 422, "CCP_CONTRACT_MISMATCH");
    return { actualCreatorIpc: 0, gate: "signed-disabledOperations" };
  });
  await evidence.scenario("gateway-environment-emergency-stop", async () => {
    const previous = process.env.CCP_EMERGENCY_STOP;
    process.env.CCP_EMERGENCY_STOP = "1";
    try { await runtime.call(runtime.clients[0], "gateway-environment-emergency-stop", 422, "CCP_GATEWAY_UNAVAILABLE"); }
    finally { if (previous === undefined) delete process.env.CCP_EMERGENCY_STOP; else process.env.CCP_EMERGENCY_STOP = previous; }
    return { actualCreatorIpc: 0, gate: "CCP_EMERGENCY_STOP-separate-from-signed-policy" };
  });
}
