import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AuthContext } from "../src/auth.ts";
import { canonicalizeToBytes } from "../src/ccp/canonical-json.ts";
import { MemoryEnvelopeSigner } from "../src/ccp/envelope-signer.ts";
import { planCreateUiNode } from "../src/ccp/planners/create-ui-node.ts";
import { ProtectedToolRegistry } from "../src/ccp/protected-tool-registry.ts";
import { ReplayStore } from "../src/ccp/replay-store.ts";
import { createCcBridgeRouter } from "../src/ccp/router.ts";
import { parseSignedGatewayDecision } from "../src/ccp/schemas.ts";
import { CcBridgeStore } from "../src/ccp/store.ts";
import { verifyGatewayDecision } from "../src/ccp/protocol.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(root, "tests", "fixtures", "ccp", "v1");
const keys = JSON.parse(readFileSync(join(fixtureRoot, "test-keys.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(fixtureRoot, "vectors.json"), "utf8"));
const executionPrivateKey = createPrivateKey({ key: Buffer.from(keys.execution.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });
const executionPublicKey = createPublicKey({ key: Buffer.from(keys.execution.publicKeySpki, "base64url"), format: "der", type: "spki" });

const auth: AuthContext = {
  member_id: "member-1",
  label: "loopback",
  jti: "jti-loopback",
  is_legacy: false,
  clearance: "internal",
  products: ["ccp"],
  tokenAlg: "EdDSA",
  role: "admin",
  exp: 2_000_000_000,
};

const store = new CcBridgeStore(":memory:");
store.insertDevice({
  id: vectors.request.deviceId,
  keyId: vectors.signedRequest.deviceKeyId,
  memberId: auth.member_id,
  publicKeySpki: Buffer.from(keys.device.publicKeySpki, "base64url"),
  fingerprint: "loopback",
  label: "loopback",
  status: "approved",
});
store.insertProject({ id: vectors.request.projectId, displayLabel: "loopback", status: "active" });
store.insertGrant({
  id: "grant-1", memberId: auth.member_id, deviceId: vectors.request.deviceId,
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

const app = express();
app.use("/ccp", createCcBridgeRouter({
  store,
  replay: new ReplayStore(store.db),
  signer: new MemoryEnvelopeSigner("execution-fixture-1", executionPrivateKey),
  planners,
  nowMs: () => vectors.request.issuedAtMs as number,
}, (req: Request, _res: Response, next: NextFunction) => {
  req.toolAuth = auth;
  next();
}));

const server = createServer(app);
await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");
const url = `http://127.0.0.1:${address.port}/ccp/v1/execute`;
const started = Date.now();
const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: new Uint8Array(canonicalizeToBytes(vectors.signedRequest)),
});
const ms = Date.now() - started;
const signed = parseSignedGatewayDecision(await response.json());
const decision = verifyGatewayDecision(signed, executionPublicKey) as { kind: string };
server.close();
if (response.status !== 200 || decision.kind !== "execute") {
  throw new Error(`loopback failed: ${response.status} ${decision.kind}`);
}
console.log(JSON.stringify({ ok: true, posts: 1, kind: decision.kind, ms, url }, null, 2));
