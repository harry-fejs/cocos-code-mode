import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router, type Request, type RequestHandler, type Response } from "express";
import type { AuthContext } from "../auth.ts";
import { CcpError, toCcpErrorBody } from "./errors.ts";
import { assertCcBridgeProduct } from "./product-grant.ts";

const COOKIE = "__Host-ccp-admin";
const LIFETIME_MS = 15 * 60_000;
interface Session { auth: AuthContext; csrf: string; expiresAtMs: number }
function cookieId(req: Request): string | undefined {
  const matches = (req.headers.cookie ?? "").split(";").map((value) => value.trim()).filter((value) => value.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? createHash("sha256").update(value).digest("hex") : undefined;
}
function reject(res: Response, status: number, message: string): void {
  res.status(status).json(toCcpErrorBody(new CcpError(status === 401 ? "CCP_AUTH_REQUIRED" : "CCP_AUTH_INVALID", message)));
}
function clearCookie(res: Response): void {
  res.clearCookie(COOKIE, { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
}

export function createAdminSessions(authenticate: RequestHandler) {
  const sessions = new Map<string, Session>();
  const configured = process.env.CCP_ADMIN_ORIGIN;
  let origin: string | undefined;
  if (configured) {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:" || parsed.origin !== configured || parsed.username || parsed.password) {
      throw new Error("CCP_ADMIN_ORIGIN must be an exact HTTPS origin without a trailing slash.");
    }
    origin = parsed.origin;
  }
  function sameOrigin(req: Request, mutation: boolean): boolean {
    return Boolean(origin && req.secure && req.get("host") === new URL(origin).host
      && (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin")
      && (mutation ? req.headers.origin === origin : !req.headers.origin || req.headers.origin === origin));
  }
  function session(req: Request): Session | undefined {
    const id = cookieId(req);
    const found = id ? sessions.get(id) : undefined;
    if (found && found.expiresAtMs > Date.now()) return found;
    if (id) sessions.delete(id);
    return undefined;
  }
  function requireSession(req: Request, res: Response, mutation: boolean): Session | undefined {
    if (!sameOrigin(req, mutation)) { reject(res, 403, "Admin sessions require the configured HTTPS origin."); return; }
    const found = session(req);
    if (!found) { clearCookie(res); reject(res, 401, "Admin session has expired; sign in again."); return; }
    const csrf = req.get("x-ccp-csrf") ?? "";
    if (mutation && (!/^[A-Za-z0-9_-]{43}$/.test(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(found.csrf)))) {
      reject(res, 403, "Admin mutation requires the session CSRF token."); return;
    }
    req.toolAuth = found.auth;
    return found;
  }
  const authorize: RequestHandler = (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const mutation = req.method !== "GET" && req.method !== "HEAD";
    if (cookieId(req) || req.headers.origin || req.headers["sec-fetch-site"]) {
      if (requireSession(req, res, mutation)) next();
      return;
    }
    // CLI automation retains bearer authorization. Browsers never receive this authority.
    authenticate(req, res, (error?: unknown) => {
      if (error) { next(error); return; }
      try {
        if (!req.toolAuth || req.toolAuth.role !== "admin") { reject(res, 403, "CCP admin authorization is required."); return; }
        assertCcBridgeProduct(req.toolAuth);
        next();
      } catch { reject(res, 403, "CCP admin authorization is required."); }
    });
  };
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.post("/session", (req, res, next) => {
    if (!sameOrigin(req, true)) { reject(res, 403, "Sign-in requires the configured HTTPS origin."); return; }
    next();
  }, express.json({ limit: "1kb" }), authenticate, (req, res) => {
    try {
      const auth = req.toolAuth;
      if (!auth || auth.role !== "admin") { reject(res, 403, "CCP admin authorization is required."); return; }
      assertCcBridgeProduct(auth);
      const now = Date.now();
      for (const [key, value] of sessions) if (value.expiresAtMs <= now) sessions.delete(key);
      const old = cookieId(req);
      if (old) sessions.delete(old);
      if (sessions.size >= 1000) { reject(res, 503, "Admin session capacity reached."); return; }
      const expiresAtMs = Math.min(now + LIFETIME_MS, auth.exp * 1000);
      if (expiresAtMs <= now) { reject(res, 401, "Admin credential expired."); return; }
      const raw = randomBytes(32).toString("base64url");
      const csrf = randomBytes(32).toString("base64url");
      sessions.set(createHash("sha256").update(raw).digest("hex"), { auth: { ...auth }, csrf, expiresAtMs });
      res.cookie(COOKIE, raw, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: expiresAtMs - now });
      res.status(201).json({ memberId: auth.member_id, csrf, expiresAtMs });
    } catch { reject(res, 403, "CCP admin authorization is required."); }
  });
  router.get("/session", (req, res) => {
    const found = requireSession(req, res, false);
    if (found) res.json({ memberId: found.auth.member_id, csrf: found.csrf, expiresAtMs: found.expiresAtMs });
  });
  router.delete("/session", (req, res) => {
    if (!requireSession(req, res, true)) return;
    sessions.delete(cookieId(req)!);
    clearCookie(res);
    res.status(204).end();
  });
  return { router, authorize };
}
