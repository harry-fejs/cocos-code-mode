import express, { Router } from "express";
import { fileURLToPath } from "node:url";
import type { CcBridgeStore } from "./store.ts";
import { parseAdminQuery, queryAdminAnalytics } from "./admin-queries.ts";
import { CcpError, toCcpErrorBody } from "./errors.ts";

export function createAdminAnalyticsRouter(store: CcBridgeStore): Router {
  const router = Router();
  router.get("/navigation", (_req, res) => {
    let portalUrl: string | null = null;
    const configured = process.env.CCP_ADMIN_PORTAL_URL;
    if (configured) {
      try {
        const url = new URL(configured);
        if (url.protocol === "https:" && !url.username && !url.password && !url.search) portalUrl = url.href;
      } catch { /* Invalid optional navigation configuration never enables another origin. */ }
    }
    res.json({ portalUrl, product: "CCP", independentBackend: true });
  });
  router.get("/analytics/:view", (req, res) => {
    try { res.json(queryAdminAnalytics(store, req.params.view, parseAdminQuery(req.query))); }
    catch (error) {
      res.status(400).json(toCcpErrorBody(error instanceof CcpError ? error
        : new CcpError("CCP_CANONICAL_INVALID", "Invalid admin filter; use bounded scalar values and an increasing range of at most 90 days.")));
    }
  });
  return router;
}

export function createAdminWebRouter(): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(express.static(fileURLToPath(new URL("../../web/", import.meta.url)), { index: "index.html", dotfiles: "deny", etag: false }));
  return router;
}
