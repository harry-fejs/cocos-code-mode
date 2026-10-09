import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth.ts";
import { canonicalizeToBytes } from "../../src/ccp/canonical-json.ts";
import { MemoryEnvelopeSigner } from "../../src/ccp/envelope-signer.ts";
import { executeProtectedTool } from "../../src/ccp/execute-service.ts";
import { planCreateUiNode } from "../../src/ccp/planners/create-ui-node.ts";
import { ProtectedToolRegistry } from "../../src/ccp/protected-tool-registry.ts";
import { signProtectedRequest } from "../../src/ccp/protocol.ts";
import { importReleaseTarget, publishRolloutPolicy } from "../../src/ccp/release-admin.ts";
import { signReleaseMetadata } from "../../src/ccp/release-metadata.ts";
import { ReplayStore } from "../../src/ccp/replay-store.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";

const fixtureRoot = join(import.meta.dirname, "..", "fixtures", "ccp", "v1");
const keys = JSON.parse(readFileSync(join(fixtureRoot, "test-keys.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(fixtureRoot, "vectors.json"), "utf8"));
const deviceKey = createPrivateKey({ key: Buffer.from(keys.device.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });
const auth: AuthContext = { member_id: "member-1", label: "fixture", jti: "fixture-policy", is_legacy: false,
  clearance: "restricted", products: ["ccp"], tokenAlg: "EdDSA", role: "admin", exp: 2_000_000_000 };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ccp-policy-regression-"));
  const path = join(directory, "gateway.sqlite");
  let store = new CcBridgeStore(path);
  const releaseKeys = generateKeyPairSync("ed25519");
  const policyKeys = generateKeyPairSync("ed25519");
  const executionKeys = generateKeyPairSync("ed25519");
  const trust = { targets: new Map([["targets", releaseKeys.publicKey]]), targetsThreshold: 1,
    policy: new Map([["policy", policyKeys.publicKey]]), policyThreshold: 1 };
  store.insertDevice({ id: vectors.request.deviceId, keyId: vectors.signedRequest.deviceKeyId, memberId: auth.member_id,
    publicKeySpki: Buffer.from(keys.device.publicKeySpki, "base64url"), fingerprint: "fixture", label: "fixture", status: "approved" });
  store.insertProject({ id: vectors.request.projectId, displayLabel: "fixture", status: "active" });
  store.insertGrant({ id: randomUUID(), memberId: auth.member_id, deviceId: vectors.request.deviceId, projectId: vectors.request.projectId,
    toolId: "createUiNode", operationClass: "mutation", expiresAtMs: null, status: "active" });
  store.insertOperationPolicy({ toolId: "createUiNode", contractVersion: 1, enabled: true, contractHash: vectors.request.tool.contractHash,
    minimumRelayBuild: "2.0.0", blockedRelayBuilds: [], creatorRange: ">=3.7.0 <3.9.0", requiredConsentVersion: "project-metadata-v1", revision: 1 });
  let targetSequence = 0; let policySequence = 0; let requestSequence = 0;
  let planned = 0; let signed = 0;
  const planners = new ProtectedToolRegistry();
  planners.register("createUiNode", 1, (context) => { planned += 1; return planCreateUiNode(context); });
  const signer = new MemoryEnvelopeSigner("execution", executionKeys.privateKey);
  const deps = { store, replay: new ReplayStore(store.db), planners, signer: { keyId: signer.keyId,
    async sign(keyId: string, bytes: Uint8Array) { signed += 1; return signer.sign(keyId, bytes); } } };
  const target = (hash: string) => importReleaseTarget(store, auth, signReleaseMetadata("target", "targets", {
    schemaVersion: 1, metadataVersion: 1, releaseSequence: ++targetSequence,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    package: { name: "ccp3x", version: `2.0.${targetSequence}`, sha256: hash, size: 100, url: "https://qualification.invalid/package.zip",
      packageManifestSha256: "1".repeat(64), sbomSha256: "2".repeat(64), provenanceSha256: "3".repeat(64) },
    compatibility: { protocol: { min: 1, max: 1 }, creator: ">=3.7.0 <3.9.0", os: ["win32"], arch: ["x64"] },
  }, releaseKeys.privateKey), trust).targetPayloadHash;
  const publish = (targetHash: string, channel: string, controls: { emergencyStop?: boolean; disabledOperations?: string[] } = {}) => {
    const wrapper = signReleaseMetadata("policy", "policy", { schemaVersion: 1, policySequence: ++policySequence,
      issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      targetPayloadSha256: targetHash, channel, ring: "1", percentage: 100, recommended: true,
      blockedBuilds: [], rollbackTargetPayloadSha256: [], disabledOperations: [], emergencyStop: false, ...controls }, policyKeys.privateKey);
    publishRolloutPolicy(store, auth, wrapper, trust);
    return wrapper;
  };
  const request = (now = Date.now()) => canonicalizeToBytes(signProtectedRequest(vectors.signedRequest.deviceKeyId, {
    ...vectors.request, requestId: randomUUID(), idempotencyKey: randomUUID(), nonce: randomBytes(16).toString("base64url"),
    issuedAtMs: now, sequence: ++requestSequence,
  }, deviceKey));
  return { deps, target, publish, request, trust,
    calls: () => ({ planned, signed }),
    execute: (body: Buffer, now = Date.now()) => executeProtectedTool(deps, auth, body, now),
    restart: () => { store.close(); store = new CcBridgeStore(path); deps.store = store; deps.replay = new ReplayStore(store.db); },
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

describe("signed release execution restrictions", () => {
  it("denies cached replay before planning/signing after restart and expiry until newer same-scope clearance", async () => {
    const f = fixture();
    try {
      const target = f.target(vectors.request.relay.packageHash);
      const body = f.request();
      expect((await f.execute(body)).status).toBe(200);
      expect(f.calls()).toEqual({ planned: 1, signed: 1 });
      f.publish(target, "stable", { emergencyStop: true });
      f.restart();
      const replay = await f.execute(body);
      expect(JSON.parse(replay.body.toString()).code).toBe("CCP_GATEWAY_UNAVAILABLE");
      const future = Date.now() + 120_000;
      const expired = await f.execute(f.request(future), future);
      expect(JSON.parse(expired.body.toString()).code).toBe("CCP_GATEWAY_UNAVAILABLE");
      expect(f.calls()).toEqual({ planned: 1, signed: 1 });
      f.publish(target, "stable");
      expect((await f.execute(f.request())).status).toBe(200);
      expect(f.calls()).toEqual({ planned: 2, signed: 2 });
    } finally { f.close(); }
  });

  it("keeps package and channel scopes distinct and cannot clear a stop by publishing another target", async () => {
    const f = fixture();
    try {
      const current = f.target(vectors.request.relay.packageHash);
      const other = f.target("a".repeat(64));
      f.publish(other, "stable", { emergencyStop: true });
      expect((await f.execute(f.request())).status).toBe(200);
      f.publish(current, "stable", { emergencyStop: true });
      f.publish(current, "preview");
      f.publish(other, "stable");
      expect(JSON.parse((await f.execute(f.request())).body.toString()).code).toBe("CCP_GATEWAY_UNAVAILABLE");
      f.publish(current, "stable");
      f.publish(current, "preview", { emergencyStop: true });
      expect(JSON.parse((await f.execute(f.request())).body.toString()).code).toBe("CCP_GATEWAY_UNAVAILABLE");
      f.publish(current, "preview");
      expect((await f.execute(f.request())).status).toBe(200);
      expect(f.calls()).toEqual({ planned: 2, signed: 2 });
    } finally { f.close(); }
  });

  it("persists selective operation denial and rejects tampered signed clearance", async () => {
    const f = fixture();
    try {
      const target = f.target(vectors.request.relay.packageHash);
      f.publish(target, "stable", { disabledOperations: ["nodeCreate"] });
      expect((await f.execute(f.request())).status).toBe(200);
      const wrapper = f.publish(target, "stable", { disabledOperations: ["createUiNode:*"] });
      f.restart();
      expect(JSON.parse((await f.execute(f.request())).body.toString()).code).toBe("CCP_CONTRACT_MISMATCH");
      const forgedBody = JSON.parse(Buffer.from(wrapper.payload, "base64url").toString());
      forgedBody.policySequence += 1; forgedBody.disabledOperations = [];
      expect(() => publishRolloutPolicy(f.deps.store, auth, { ...wrapper, payload: canonicalizeToBytes(forgedBody).toString("base64url") }, f.trust)).toThrow();
      expect(JSON.parse((await f.execute(f.request())).body.toString()).code).toBe("CCP_CONTRACT_MISMATCH");
      expect(f.calls()).toEqual({ planned: 1, signed: 1 });
      f.publish(target, "stable");
      expect((await f.execute(f.request())).status).toBe(200);
    } finally { f.close(); }
  });
});
