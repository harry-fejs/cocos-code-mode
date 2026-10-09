import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth.ts";
import { canonicalizeToBytes } from "../../src/ccp/canonical-json.ts";
import { MemoryEnvelopeSigner, type EnvelopeSigner } from "../../src/ccp/envelope-signer.ts";
import { approveEnrolledDevice, enrollDevice, issueEnrollmentChallenge } from "../../src/ccp/enrollment.ts";
import { enrollmentProofBytes } from "../../src/ccp/device-proof.ts";
import { executeProtectedTool, type ExecuteDependencies } from "../../src/ccp/execute-service.ts";
import { planCreateUiNode } from "../../src/ccp/planners/create-ui-node.ts";
import { ProtectedToolRegistry } from "../../src/ccp/protected-tool-registry.ts";
import { ReplayStore } from "../../src/ccp/replay-store.ts";
import { parseGatewayDecision, parseSignedGatewayDecision } from "../../src/ccp/schemas.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";
import { signProtectedRequest, verifyGatewayDecision } from "../../src/ccp/protocol.ts";

const fixtureRoot = join(import.meta.dirname, "..", "fixtures", "ccp", "v1");
const keys = JSON.parse(readFileSync(join(fixtureRoot, "test-keys.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(fixtureRoot, "vectors.json"), "utf8"));
const executionPrivateKey = createPrivateKey({ key: Buffer.from(keys.execution.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });
const executionPublicKey = createPublicKey({ key: Buffer.from(keys.execution.publicKeySpki, "base64url"), format: "der", type: "spki" });
const devicePrivateKey = createPrivateKey({ key: Buffer.from(keys.device.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });

class FailingCompleteReplayStore extends ReplayStore {
  override complete(): void {
    throw new Error("forced response persistence failure");
  }
}

const failingSigner: EnvelopeSigner = {
  keyId: "execution-fixture-1",
  async sign() {
    throw new Error("forced signer failure");
  },
};

const auth: AuthContext = {
  member_id: "member-1",
  label: "fixture",
  jti: "jti-1",
  is_legacy: false,
  clearance: "internal",
  products: ["ccp"],
  tokenAlg: "EdDSA",
  exp: 2_000_000_000,
};

function runtime(enrollIdentity = false) {
  const store = new CcBridgeStore(":memory:");
  if (enrollIdentity) {
    const challenge = issueEnrollmentChallenge(store, auth, { label: "fixture" }, vectors.request.issuedAtMs - 1);
    const fields = {
      ...challenge,
      deviceId: vectors.request.deviceId,
      deviceKeyId: vectors.signedRequest.deviceKeyId,
      publicKeySpki: keys.device.publicKeySpki,
    };
    enrollDevice(store, auth, {
      ...fields,
      proofSignature: sign(null, enrollmentProofBytes(fields), devicePrivateKey).toString("base64url"),
    }, vectors.request.issuedAtMs);
    approveEnrolledDevice(store, { ...auth, role: "admin" }, vectors.request.deviceId, vectors.request.issuedAtMs);
  } else {
    store.insertDevice({
      id: vectors.request.deviceId,
      keyId: vectors.signedRequest.deviceKeyId,
      memberId: auth.member_id,
      publicKeySpki: Buffer.from(keys.device.publicKeySpki, "base64url"),
      fingerprint: "fixture-device",
      label: "fixture",
      status: "approved",
    });
  }
  store.insertProject({ id: vectors.request.projectId, displayLabel: "fixture", status: "active" });
  store.insertGrant({
    id: "grant-1",
    memberId: auth.member_id,
    deviceId: vectors.request.deviceId,
    projectId: vectors.request.projectId,
    toolId: "createUiNode",
    operationClass: "mutation",
    expiresAtMs: null,
    status: "active",
  });
  store.insertOperationPolicy({
    toolId: "createUiNode",
    contractVersion: 1,
    enabled: true,
    contractHash: vectors.request.tool.contractHash,
    minimumRelayBuild: "2.0.0",
    blockedRelayBuilds: [],
    creatorRange: ">=3.7.0 <3.9.0",
    requiredConsentVersion: "project-metadata-v1",
    revision: 1,
  });
  const planners = new ProtectedToolRegistry();
  planners.register("createUiNode", 1, planCreateUiNode);
  return {
    store,
    replay: new ReplayStore(store.db),
    signer: new MemoryEnvelopeSigner("execution-fixture-1", executionPrivateKey),
    planners,
  };
}

describe("CCP execute control plane", () => {
  it("returns one signed decision for an authenticated request", async () => {
    const result = await executeProtectedTool(runtime(), auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(result.status).toBe(200);
    const signed = parseSignedGatewayDecision(JSON.parse(result.body.toString("utf8")));
    const decision = parseGatewayDecision(verifyGatewayDecision(signed, executionPublicKey));
    expect(decision.kind).toBe("execute");
    expect(decision.binding.requestId).toBe(vectors.request.requestId);
  });

  it("persists signed completion telemetry without affecting execution", async () => {
    const deps = runtime();
    const completedRequest = {
      ...vectors.request,
      priorTelemetry: [{ requestId: "11111111-1111-4111-8111-111111111111", outcome: "completed", durationMs: 17 }],
    };
    const signedRequest = signProtectedRequest(vectors.signedRequest.deviceKeyId, completedRequest, devicePrivateKey);
    const result = await executeProtectedTool(deps, auth, canonicalizeToBytes(signedRequest), vectors.request.issuedAtMs);
    expect(result.status).toBe(200);
    expect(deps.store.db.prepare("SELECT request_id, outcome, duration_ms FROM ccp_completion_telemetry").get())
      .toEqual({ request_id: "11111111-1111-4111-8111-111111111111", outcome: "completed", duration_ms: 17 });
    expect(deps.store.db.prepare("SELECT request_id FROM ccp_audit ORDER BY id DESC LIMIT 1").get())
      .toEqual({ request_id: vectors.request.requestId });
  });

  it("executes with the unchanged relay-generated device identity after enrollment and approval", async () => {
    const deps = runtime(true);
    expect(deps.store.getDeviceByKeyId(vectors.signedRequest.deviceKeyId)?.id).toBe(vectors.request.deviceId);
    const result = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(result.status).toBe(200);
  });

  it("denies execute from a pending device and allows it after approval", async () => {
    const deps = runtime();
    deps.store.db.prepare("UPDATE device SET status = 'pending'").run();
    const denied = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(JSON.parse(denied.body.toString("utf8")).code).toBe("CCP_DEVICE_DENIED");
    expect(deps.store.approveDevice(vectors.request.deviceId)).toBe(true);
    const allowed = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(allowed.status).toBe(200);
  });

  it("denies execute after device revoke", async () => {
    const deps = runtime();
    const first = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(first.status).toBe(200);
    expect(deps.store.revokeDevice(vectors.request.deviceId)).toBe(true);
    const denied = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(JSON.parse(denied.body.toString("utf8")).code).toBe("CCP_DEVICE_DENIED");
  });

  it("denies missing grants before planning or signing", async () => {
    const deps = runtime();
    deps.store.db.prepare("UPDATE grant_record SET status = 'revoked'").run();
    const result = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(result.status).toBe(422);
    expect(JSON.parse(result.body.toString("utf8")).code).toBe("CCP_PROJECT_DENIED");
    expect(deps.store.counts().replayRows).toBe(0);
  });

  it("replays the exact stored response for a completed duplicate", async () => {
    const deps = runtime();
    const first = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    const second = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(first.status).toBe(200);
    expect(second.body.equals(first.body)).toBe(true);
  });

  it.each([
    ["grant revocation", (deps: { store: CcBridgeStore }) => {
      deps.store.db.prepare("UPDATE grant_record SET status = 'revoked'").run();
    }, "CCP_PROJECT_DENIED"],
    ["project disablement", (deps: { store: CcBridgeStore }) => {
      deps.store.db.prepare("UPDATE project SET status = 'disabled'").run();
    }, "CCP_PROJECT_DENIED"],
    ["policy disablement", (deps: { store: CcBridgeStore }) => {
      deps.store.db.prepare("UPDATE operation_policy SET enabled = 0").run();
    }, "CCP_CONTRACT_MISMATCH"],
    ["relay-build blocking", (deps: { store: CcBridgeStore }) => {
      deps.store.db.prepare("UPDATE operation_policy SET blocked_relay_builds_json = ?")
        .run(JSON.stringify([vectors.request.relay.build]));
    }, "CCP_BUILD_INCOMPATIBLE"],
  ] as const)("reauthorizes a completed retry after %s", async (_name, revoke, expectedCode) => {
    const deps = runtime();
    const first = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(first.status).toBe(200);
    revoke(deps);
    const retry = await executeProtectedTool(deps, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(JSON.parse(retry.body.toString("utf8")).code).toBe(expectedCode);
  });

  it.each([
    ["planner", 422],
    ["signer", 500],
    ["persist", 500],
  ] as const)(
    "durably releases a %s failure for one same-digest recovery",
    async (failureClass, expectedStatus) => {
      const deps = runtime();
      let failing: ExecuteDependencies;
      if (failureClass === "planner") {
        failing = { ...deps, planners: new ProtectedToolRegistry() };
      } else if (failureClass === "signer") {
        failing = { ...deps, signer: failingSigner };
      } else {
        failing = { ...deps, replay: new FailingCompleteReplayStore(deps.store.db) };
      }

      const first = await executeProtectedTool(failing, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
      expect(first.status).toBe(expectedStatus);
      expect(deps.store.db.prepare(
        "SELECT state, failure_class FROM request_idempotency",
      ).get()).toMatchObject({ state: "failed", failure_class: failureClass });

      const restarted = { ...deps, replay: new ReplayStore(deps.store.db) };
      const recovered = await executeProtectedTool(restarted, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
      const completedRetry = await executeProtectedTool(restarted, auth, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
      expect(recovered.status).toBe(200);
      expect(completedRetry.body.equals(recovered.body)).toBe(true);
      expect(deps.store.db.prepare(
        "SELECT state, COUNT(*) AS count FROM request_idempotency GROUP BY state",
      ).get()).toMatchObject({ state: "completed", count: 1 });
    },
  );

  it("rejects a missing product grant", async () => {
    const result = await executeProtectedTool(runtime(), { ...auth, products: [] }, canonicalizeToBytes(vectors.signedRequest), vectors.request.issuedAtMs);
    expect(JSON.parse(result.body.toString("utf8")).code).toBe("CCP_PRODUCT_DENIED");
  });
});
