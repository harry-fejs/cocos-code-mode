import { createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth.ts";
import {
  createGatewayAdmission,
  type AdmissionConfig,
} from "../../src/ccp/admission.ts";

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

function config(overrides: Partial<AdmissionConfig> = {}): AdmissionConfig {
  return {
    allowedHosts: new Set(["127.0.0.1"]),
    ipRequestsPerMinute: 10,
    memberRequestsPerMinute: 10,
    maxTrackedKeys: 100,
    concurrentExecute: 1,
    queuedExecute: 1,
    queueTimeoutMs: 15,
    ...overrides,
  };
}

function stubAuth(req: Request, _res: Response, next: NextFunction): void {
  req.toolAuth = auth;
  next();
}

async function getWithHost(url: string, host: string): Promise<{ status: number; body: unknown }> {
  const deferred = Promise.withResolvers<{ status: number; body: unknown }>();
  const request = httpRequest(url, { headers: { host } }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      deferred.resolve({ status: response.statusCode ?? 0, body });
    });
  });
  request.on("error", deferred.reject);
  request.end();
  return deferred.promise;
}

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

describe("CCP Gateway admission", () => {
  it("rejects an unconfigured Host and bounds requests by IP", async () => {
    const admission = createGatewayAdmission(config({ ipRequestsPerMinute: 1 }));
    const app = express();
    app.get("/", admission.enforceHostAndIp, (_req, res) => res.json({ ok: true }));
    await withServer(app, async (baseUrl) => {
      const wrongHost = await getWithHost(baseUrl, "evil.example");
      expect(wrongHost.status).toBe(400);
      expect(wrongHost.body).toMatchObject({ code: "CCP_AUTH_INVALID" });

      const first = await fetch(baseUrl);
      expect(first.status).toBe(200);
      const limited = await fetch(baseUrl);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ code: "CCP_BUSY" });
    });
  });

  it("bounds authenticated members independently", async () => {
    const admission = createGatewayAdmission(config({ memberRequestsPerMinute: 1 }));
    const app = express();
    app.get("/", stubAuth, admission.enforceMemberRate, (_req, res) => res.json({ ok: true }));
    await withServer(app, async (baseUrl) => {
      expect((await fetch(baseUrl)).status).toBe(200);
      const limited = await fetch(baseUrl);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ code: "CCP_BUSY" });
    });
  });

  it("times out queued execute work without entering its handler", async () => {
    const admission = createGatewayAdmission(config());
    let entered = 0;
    const app = express();
    app.get("/", admission.enforceExecuteConcurrency, async (_req, res) => {
      entered += 1;
      await delay(50);
      res.json({ ok: true });
    });
    await withServer(app, async (baseUrl) => {
      const active = fetch(baseUrl);
      await delay(5);
      const queued = await fetch(baseUrl);
      expect(queued.status).toBe(429);
      expect(await queued.json()).toMatchObject({ code: "CCP_BUSY" });
      expect((await active).status).toBe(200);
      expect(entered).toBe(1);
    });
  });
});
