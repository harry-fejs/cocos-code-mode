import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createMemberTokenVerifier, type AuthContext } from "../../src/auth.ts";
import { canonicalizeToBytes } from "../../src/ccp/canonical-json.ts";
import { MemoryEnvelopeSigner } from "../../src/ccp/envelope-signer.ts";
import { planCreateUiNode } from "../../src/ccp/planners/create-ui-node.ts";
import { ProtectedToolRegistry } from "../../src/ccp/protected-tool-registry.ts";
import { ReplayStore } from "../../src/ccp/replay-store.ts";
import { createCcBridgeRouter } from "../../src/ccp/router.ts";
import { parseSignedGatewayDecision } from "../../src/ccp/schemas.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";
import { verifyGatewayDecision } from "../../src/ccp/protocol.ts";
import { createMemberAuthMiddleware } from "../../src/ccp/auth-middleware.ts";

const fixtureRoot = join(import.meta.dirname, "..", "fixtures", "ccp", "v1");
const keys = JSON.parse(readFileSync(join(fixtureRoot, "test-keys.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(fixtureRoot, "vectors.json"), "utf8"));
const executionPrivateKey = createPrivateKey({ key: Buffer.from(keys.execution.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });
const executionPublicKey = createPublicKey({ key: Buffer.from(keys.execution.publicKeySpki, "base64url"), format: "der", type: "spki" });
const auth: AuthContext = {
  member_id: "member-1",
  label: "fixture",
  jti: "jti-1",
  is_legacy: false,
  clearance: "internal",
  products: ["ccp"],
  tokenAlg: "EdDSA",
  role: "admin",
  exp: 2_000_000_000,
};

function runtime() {
  const store = new CcBridgeStore(":memory:");
  store.insertDevice({
    id: vectors.request.deviceId,
    keyId: vectors.signedRequest.deviceKeyId,
    memberId: auth.member_id,
    publicKeySpki: Buffer.from(keys.device.publicKeySpki, "base64url"),
    fingerprint: "fixture-device",
    label: "fixture",
    status: "approved",
  });
  store.insertProject({ id: vectors.request.projectId, displayLabel: "fixture", status: "active" });
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
  return {
    store,
    replay: new ReplayStore(store.db),
    signer: new MemoryEnvelopeSigner("execution-fixture-1", executionPrivateKey),
    planners,
    nowMs: () => vectors.request.issuedAtMs as number,
  };
}

function stubAuth(req: Request, _res: Response, next: NextFunction): void {
  req.toolAuth = auth;
  next();
}

async function signMemberJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ label: "fixture", role: "admin", products: ["ccp"] })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer("mcpdocs")
    .setSubject(auth.member_id)
    .setJti(auth.jti)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(executionPrivateKey);
}

describe("CCP HTTP execute", () => {
  it("returns one signed decision from POST /ccp/v1/execute", async () => {
    const app = express();
    app.use("/ccp", createCcBridgeRouter(runtime(), stubAuth));
    const server = createServer(app);
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const health = await fetch(`http://127.0.0.1:${address.port}/ccp/v1/health`);
      expect((await health.json() as { signer: string }).signer).toBe("configured");
      const response = await fetch(`http://127.0.0.1:${address.port}/ccp/v1/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array(canonicalizeToBytes(vectors.signedRequest)),
      });
      expect(response.status).toBe(200);
      const signed = parseSignedGatewayDecision(await response.json());
      expect(verifyGatewayDecision(signed, executionPublicKey)).toMatchObject({ kind: "execute" });
    } finally {
      server.close();
    }
  });

  it("lists devices, grants, and next canary cohort for an admin", async () => {
    const app = express();
    app.use("/ccp", createCcBridgeRouter(runtime(), stubAuth));
    const server = createServer(app);
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}/ccp/v1`;
    try {
      const devices = await (await fetch(`${base}/admin/devices`)).json() as { devices: { status: string }[] };
      expect(devices.devices).toHaveLength(1);
      expect(devices.devices[0].status).toBe("approved");
      const grants = await (await fetch(`${base}/admin/grants`)).json() as { grants: { id: string }[] };
      expect(grants.grants).toHaveLength(1);
      const rollout = await (await fetch(`${base}/admin/rollout`)).json() as { next: number | "ga"; healthyDevices: number };
      expect(rollout.healthyDevices).toBe(1);
      expect(rollout.next).toBe(3);
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      expect(await metrics.text()).toContain("ccp_runtime_state");
    } finally {
      server.close();
    }
  });

  it("authenticates before parsing JSON and returns typed parser errors", async () => {
    const verifier = createMemberTokenVerifier({
      issuer: "mcpdocs",
      publicKeyPem: executionPublicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    const app = express();
    app.use("/ccp", createCcBridgeRouter(runtime(), createMemberAuthMiddleware(verifier)));
    const server = createServer(app);
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}/ccp/v1/devices/enroll`;
    try {
      const unauthenticated = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("content-type")).toContain("application/json");
      expect(await unauthenticated.json()).toMatchObject({ code: "CCP_AUTH_REQUIRED" });

      const malformed = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await signMemberJwt()}`,
          "content-type": "application/json",
        },
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("content-type")).toContain("application/json");
      expect(await malformed.json()).toMatchObject({ code: "CCP_CANONICAL_INVALID" });
    } finally {
      server.close();
    }
  });
});
