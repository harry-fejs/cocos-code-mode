import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../src/auth.ts";
import { createMemberAuthMiddleware } from "../../src/ccp/auth-middleware.ts";
import { createAdminSessions } from "../../src/ccp/admin-session.ts";
import { createCcBridgeRuntime } from "../../src/ccp/runtime.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";

const auth: AuthContext = { member_id: "admin-one", label: "test", jti: "test", is_legacy: false,
  clearance: "restricted", products: ["ccp"], tokenAlg: "EdDSA", role: "admin", exp: 2_000_000_000 };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function surface(claims = auth) {
  const app = express(); app.set("trust proxy", "loopback");
  let writes = 0;
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const origin = `https://127.0.0.1:${address.port}`;
  vi.stubEnv("CCP_ADMIN_ORIGIN", origin);
  const admin = createAdminSessions(createMemberAuthMiddleware({
    async verify(token) { if (token !== "fixture") throw new Error("invalid"); return claims; },
  }));
  app.use("/admin", admin.router);
  app.post("/admin/mutate", admin.authorize, (_req, res) => { writes++; res.json({ writes }); });
  return {
    origin,
    writes: () => writes,
    async call(path: string, method = "POST", headers: Record<string, string> = {}) {
      return fetch(`http://127.0.0.1:${address.port}/admin/${path}`, { method, headers: { "X-Forwarded-Proto": "https", ...headers } });
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

it("prunes retained admin metadata when the Gateway runtime starts", async () => {
  const priorPath = process.env.CCP_DB_PATH;
  const file = `${process.cwd()}/.tmp-admin-retention-${randomUUID()}.sqlite`;
  process.env.CCP_DB_PATH = file;
  const seed = new CcBridgeStore(file);
  const expired = Date.now() - 91 * 86_400_000;
  seed.db.prepare("INSERT INTO ccp_security_event(timestamp_ms,event_type,result_class) VALUES (?,?,?)")
    .run(expired, "device.approve", "ok");
  seed.db.prepare("INSERT INTO ccp_usage_hour VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(expired, "m", "d", "p", "t", "b", "ok", "", 1, 1, 1);
  seed.close();
  const runtime = createCcBridgeRuntime();
  try {
    expect(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM ccp_security_event").get()).toEqual({ count: 0 });
    expect(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM ccp_usage_hour").get()).toEqual({ count: 0 });
  } finally {
    runtime.store.close();
    process.env.CCP_DB_PATH = priorPath;
    rmSync(file, { force: true });
  }
});

describe("CCP admin session authority", () => {
  it("requires an authorized HTTPS origin, then binds mutations to session and CSRF; logout revokes authority", async () => {
    const app = await surface();
    try {
      expect((await app.call("session", "POST", { Origin: "https://attacker.test", Authorization: "Bearer fixture" })).status).toBe(403);
      expect((await app.call("session", "POST", { Origin: app.origin, Authorization: "Bearer fixture", "X-Forwarded-Proto": "http" })).status).toBe(403);
      expect((await app.call("session", "POST", { Origin: app.origin })).status).toBe(401);
      const login = await app.call("session", "POST", { Origin: app.origin, Authorization: "Bearer fixture" });
      expect(login.status).toBe(201);
      const setCookie = login.headers.get("set-cookie")!;
      expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("Secure"); expect(setCookie).toContain("SameSite=Strict");
      const cookie = setCookie.split(";")[0];
      const session = await login.json() as { csrf: string };
      expect((await app.call("mutate", "POST", { Origin: app.origin, Cookie: cookie })).status).toBe(403);
      expect((await app.call("mutate", "POST", { Origin: "https://attacker.test", Cookie: cookie, "x-ccp-csrf": session.csrf })).status).toBe(403);
      expect((await app.call("mutate", "POST", { Origin: app.origin, Authorization: "Bearer fixture" })).status).toBe(401);
      expect(app.writes()).toBe(0);
      const headers = { Origin: app.origin, Cookie: cookie, "x-ccp-csrf": session.csrf };
      expect((await app.call("mutate", "POST", headers)).status).toBe(200);
      expect(app.writes()).toBe(1);
      expect((await app.call("session", "DELETE", headers)).status).toBe(204);
      expect((await app.call("mutate", "POST", headers)).status).toBe(401);
      expect(app.writes()).toBe(1);
      expect((await app.call("mutate", "POST", { Authorization: "Bearer fixture" })).status).toBe(200);
    } finally { await app.close(); }
  });

  it("expires at the earlier JWT lifetime and denies non-admin/product-missing credentials", async () => {
    const now = Date.now();
    const app = await surface({ ...auth, exp: Math.floor(now / 1000) + 30 });
    try {
      const login = await app.call("session", "POST", { Origin: app.origin, Authorization: "Bearer fixture" });
      const session = await login.json() as { csrf: string; expiresAtMs: number };
      expect(session.expiresAtMs).toBeLessThanOrEqual(now + 30_000);
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      vi.spyOn(Date, "now").mockReturnValue(session.expiresAtMs + 1);
      expect((await app.call("mutate", "POST", { Origin: app.origin, Cookie: cookie, "x-ccp-csrf": session.csrf })).status).toBe(401);
      expect(app.writes()).toBe(0);
    } finally { await app.close(); vi.restoreAllMocks(); }
    for (const claims of [{ ...auth, role: "searcher" as const }, { ...auth, products: [] }]) {
      const denied = await surface(claims);
      try {
        expect((await denied.call("session", "POST", { Origin: denied.origin, Authorization: "Bearer fixture" })).status).toBe(403);
        expect((await denied.call("mutate", "POST", { Authorization: "Bearer fixture" })).status).toBe(403);
        expect(denied.writes()).toBe(0);
      } finally { await denied.close(); }
    }
  });
});
