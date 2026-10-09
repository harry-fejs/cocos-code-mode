import { createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import {
  signProtectedRequest,
  verifyGatewayDecision,
  type ProtectedRequest,
} from "../src/ccp/protocol.ts";
import { parseSignedGatewayDecision } from "../src/ccp/schemas.ts";
import { CcBridgeStore } from "../src/ccp/store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(root, "tests", "fixtures", "ccp", "v1");
const keys = JSON.parse(readFileSync(join(fixtureRoot, "test-keys.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(fixtureRoot, "vectors.json"), "utf8"));
const databasePath = process.env.CCP_DB_PATH;
if (!databasePath) throw new Error("CCP_DB_PATH is required");

function prepare(): void {
  const store = new CcBridgeStore(databasePath);
  try {
    store.insertDevice({
      id: vectors.request.deviceId,
      keyId: vectors.signedRequest.deviceKeyId,
      memberId: "member-1",
      publicKeySpki: Buffer.from(keys.device.publicKeySpki, "base64url"),
      fingerprint: "production-smoke",
      label: "production-smoke",
      status: "approved",
    });
    store.insertProject({ id: vectors.request.projectId, displayLabel: "production-smoke", status: "active" });
    store.insertGrant({
      id: randomUUID(),
      memberId: "member-1",
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
  } finally {
    store.close();
  }
  console.log(JSON.stringify({ ok: true, mode: "prepare", databasePath }));
}

async function execute(): Promise<void> {
  const memberPrivateKeyPath = process.env.DTX_MEMBER_JWT_PRIVATE_KEY_PATH;
  const executionPublicKeyPath = process.env.CCP_EXECUTION_PUBLIC_KEY_PATH;
  const gatewayUrl = process.env.CCP_SMOKE_URL ?? "http://127.0.0.1:8787/ccp/v1/execute";
  if (!memberPrivateKeyPath || !executionPublicKeyPath) {
    throw new Error("DTX_MEMBER_JWT_PRIVATE_KEY_PATH and CCP_EXECUTION_PUBLIC_KEY_PATH are required");
  }
  const nowMs = Date.now();
  const request: ProtectedRequest = {
    ...vectors.request,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    sequence: 1,
    issuedAtMs: nowMs,
    nonce: randomBytes(16).toString("base64url"),
  };
  const devicePrivateKey = createPrivateKey({
    key: Buffer.from(keys.device.privateKeyPkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const signedRequest = signProtectedRequest(vectors.signedRequest.deviceKeyId, request, devicePrivateKey);
  const nowSeconds = Math.floor(nowMs / 1_000);
  const memberToken = await new SignJWT({ label: "production smoke", role: "admin", products: ["ccp"] })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(process.env.DTX_MEMBER_JWT_ISSUER ?? "mcpdocs")
    .setSubject("member-1")
    .setJti(randomUUID())
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 300)
    .sign(createPrivateKey(readFileSync(memberPrivateKeyPath)));

  const startedAt = performance.now();
  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${memberToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(signedRequest),
  });
  const body = await response.json() as unknown;
  if (response.status !== 200) throw new Error(`Gateway smoke failed (${response.status}): ${JSON.stringify(body)}`);
  const signedDecision = parseSignedGatewayDecision(body);
  const executionPublicKey = createPublicKey(readFileSync(executionPublicKeyPath));
  const decision = verifyGatewayDecision(signedDecision, executionPublicKey) as { kind: string; binding?: { requestId?: string } };
  if (decision.kind !== "execute" || decision.binding?.requestId !== request.requestId) {
    throw new Error("Gateway smoke returned an invalid or wrongly bound decision");
  }
  console.log(JSON.stringify({
    ok: true,
    mode: "execute",
    posts: 1,
    kind: decision.kind,
    requestId: request.requestId,
    milliseconds: performance.now() - startedAt,
  }));
}

if (process.argv[2] === "prepare") prepare();
else if (process.argv[2] === "execute") await execute();
else throw new Error("Usage: ccp-production-smoke.ts prepare|execute");
