import { createServer } from "node:http";
import express from "express";
import { exportSPKI, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createMemberTokenVerifier,
  type MemberTokenVerifier,
} from "../../src/auth.ts";
import {
  createMemberAuthMiddleware,
  requireCcBridgeProduct,
} from "../../src/ccp/auth-middleware.ts";

const issuer = "mcpdocs";
let privateKey: KeyLike;
let verifier: MemberTokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  privateKey = pair.privateKey;
  verifier = createMemberTokenVerifier({
    publicKeyPem: await exportSPKI(pair.publicKey),
    issuer,
  });
});

async function signToken(options: {
  algorithm?: "EdDSA" | "HS256";
  issuer?: string;
  products?: unknown;
  expiresInSeconds?: number;
  extra?: Record<string, unknown>;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const algorithm = options.algorithm ?? "EdDSA";
  const jwt = new SignJWT({
    label: "fixture member",
    role: "admin",
    products: options.products ?? ["ccp"],
    ...options.extra,
  })
    .setProtectedHeader({ alg: algorithm, typ: "JWT" })
    .setIssuer(options.issuer ?? issuer)
    .setSubject("member-1")
    .setJti("jti-1")
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 300));
  if (algorithm === "HS256") return jwt.sign(new TextEncoder().encode("fixture-secret-at-least-32-bytes-long"));
  return jwt.sign(privateKey);
}

async function requestThroughAuth(token?: string): Promise<Response> {
  const app = express();
  app.get("/protected", createMemberAuthMiddleware(verifier), requireCcBridgeProduct, (req, res) => {
    res.json({
      memberId: req.toolAuth?.member_id,
      products: req.toolAuth?.products,
      clearance: req.toolAuth?.clearance,
    });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP port");
  try {
    return await fetch(`http://127.0.0.1:${address.port}/protected`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
  } finally {
    server.close();
  }
}

describe("independent member JWT verification", () => {
  it("accepts a valid EdDSA token and maps its shared identity claims", async () => {
    const response = await requestThroughAuth(await signToken());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      memberId: "member-1",
      products: ["ccp"],
      clearance: "restricted",
    });
  });

  it("preserves explicit signed clearance instead of applying the role default", async () => {
    const response = await requestThroughAuth(await signToken({ extra: { clearance: "internal" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ clearance: "internal" });
  });

  it("denies a valid identity token without the ccp product", async () => {
    const response = await requestThroughAuth(await signToken({ products: ["mcpdocs"] }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "CCP_PRODUCT_DENIED" });
  });

  it.each([
    ["missing bearer", undefined],
    ["HS256", async () => signToken({ algorithm: "HS256" })],
    ["wrong issuer", async () => signToken({ issuer: "other-product" })],
    ["expired", async () => signToken({ expiresInSeconds: -1 })],
    ["mixed-type products", async () => signToken({ products: ["ccp", 1] })],
  ])("denies %s before entering the protected handler", async (_name, tokenFactory) => {
    const token = typeof tokenFactory === "function" ? await tokenFactory() : undefined;
    const response = await requestThroughAuth(token);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: token ? "CCP_AUTH_INVALID" : "CCP_AUTH_REQUIRED",
    });
  });
});
