import { createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthContext } from "../../src/auth.ts";
import { canonicalizeToBytes } from "../../src/ccp/canonical-json.ts";
import { MemoryEnvelopeSigner } from "../../src/ccp/envelope-signer.ts";
import { executeProtectedTool, type ExecuteDependencies } from "../../src/ccp/execute-service.ts";
import { planCreateUiNode } from "../../src/ccp/planners/create-ui-node.ts";
import { ProtectedToolRegistry } from "../../src/ccp/protected-tool-registry.ts";
import { signProtectedRequest, type ProtectedRequest } from "../../src/ccp/protocol.ts";
import { ReplayStore } from "../../src/ccp/replay-store.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";
import { ccpMetricsRegistry } from "../../src/ccp/metrics.ts";

// Simulated-device benchmark for the Gateway server phases. Loopback only — NOT
// release evidence (see phase-05: live TLS path is the only accepted proof).

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(root, "tests", "fixtures", "ccp", "v1");
const keys = JSON.parse(readFileSync(join(fixtureRoot, "test-keys.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(fixtureRoot, "vectors.json"), "utf8"));

const samples = Number(process.env.CCP_BENCH_SAMPLES ?? "100");
const warmups = Number(process.env.CCP_BENCH_WARMUPS ?? "10");

const executionPrivateKey = createPrivateKey({ key: Buffer.from(keys.execution.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });
const devicePrivateKey = createPrivateKey({ key: Buffer.from(keys.device.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });

const auth: AuthContext = {
  member_id: "member-1",
  label: "bench",
  jti: "jti-bench",
  is_legacy: false,
  clearance: "internal",
  products: ["ccp"],
  tokenAlg: "EdDSA",
  role: "admin",
  exp: 2_000_000_000,
};

function seedDeps(): ExecuteDependencies {
  const store = new CcBridgeStore(":memory:");
  store.insertDevice({
    id: vectors.request.deviceId,
    keyId: vectors.signedRequest.deviceKeyId,
    memberId: auth.member_id,
    publicKeySpki: Buffer.from(keys.device.publicKeySpki, "base64url"),
    fingerprint: "bench",
    label: "bench",
    status: "approved",
  });
  store.insertProject({ id: vectors.request.projectId, displayLabel: "bench", status: "active" });
  store.insertGrant({
    id: randomUUID(), memberId: auth.member_id, deviceId: vectors.request.deviceId,
    projectId: vectors.request.projectId, toolId: "createUiNode", operationClass: "mutation",
    expiresAtMs: null, status: "active",
  });
  store.insertOperationPolicy({
    toolId: "createUiNode", contractVersion: 1, enabled: true, contractHash: vectors.request.tool.contractHash,
    minimumRelayBuild: "2.0.0", blockedRelayBuilds: [], creatorRange: ">=3.7.0 <3.9.0",
    requiredConsentVersion: "project-metadata-v1", revision: 1,
  });
  const planners = new ProtectedToolRegistry();
  planners.register("createUiNode", 1, planCreateUiNode);
  return {
    store,
    replay: new ReplayStore(store.db),
    signer: new MemoryEnvelopeSigner("execution-fixture-1", executionPrivateKey),
    planners,
    nowMs: () => Date.now(),
  };
}

function buildWrapper(sequence: number): Buffer {
  const nowMs = Date.now();
  const request: ProtectedRequest = {
    ...vectors.request,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    sequence,
    issuedAtMs: nowMs,
    nonce: randomBytes(16).toString("base64url"),
  };
  const signed = signProtectedRequest(vectors.signedRequest.deviceKeyId, request, devicePrivateKey);
  return Buffer.from(canonicalizeToBytes(signed));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function main(): Promise<void> {
  const deps = seedDeps();
  const latencies: number[] = [];

  const runOnce = async (sequence: number): Promise<number> => {
    const wrapper = buildWrapper(sequence);
    const started = performance.now();
    const result = await executeProtectedTool(deps, auth, wrapper);
    const ms = performance.now() - started;
    if (result.status !== 200) throw new Error(`execute failed: ${result.status} ${result.body.toString()}`);
    return ms;
  };

  for (let i = 0; i < warmups; i += 1) await runOnce(i + 1);
  for (let i = 0; i < samples; i += 1) latencies.push(await runOnce(warmups + i + 1));

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const phaseSummary = await ccpMetricsRegistry.metrics();

  console.log(JSON.stringify({
    samples,
    warmups,
    total: {
      medianMs: Number(percentile(sorted, 50).toFixed(3)),
      p95Ms: Number(percentile(sorted, 95).toFixed(3)),
      p99Ms: Number(percentile(sorted, 99).toFixed(3)),
      minMs: Number(sorted[0].toFixed(3)),
      maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
      meanMs: Number((sum / sorted.length).toFixed(3)),
    },
    phases: {
      hasVerify: phaseSummary.includes('phase="verify"'),
      hasAuthorize: phaseSummary.includes('phase="authorize"'),
      hasPlan: phaseSummary.includes('phase="plan"'),
      hasValidate: phaseSummary.includes('phase="validate"'),
      hasSign: phaseSummary.includes('phase="sign"'),
      hasPersist: phaseSummary.includes('phase="persist"'),
    },
  }, null, 2));
}

await main();
