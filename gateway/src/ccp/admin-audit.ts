import type { RequestHandler } from "express";
import type { CcBridgeStore } from "./store.ts";

export const DETAIL_RETENTION_MS = 7 * 86_400_000;
export const AGGREGATE_RETENTION_MS = 90 * 86_400_000;
const nextPrune = new WeakMap<CcBridgeStore, number>();

export function retainAdminMetadata(store: CcBridgeStore, nowMs = Date.now()): void {
  if ((nextPrune.get(store) ?? 0) > nowMs) return;
  store.db.transaction(() => {
    store.db.prepare("DELETE FROM ccp_audit WHERE timestamp_ms < ?").run(nowMs - DETAIL_RETENTION_MS);
    store.db.prepare("DELETE FROM ccp_completion_telemetry WHERE received_at_ms < ?").run(nowMs - DETAIL_RETENTION_MS);
    store.db.prepare("DELETE FROM ccp_security_event WHERE timestamp_ms < ?").run(nowMs - AGGREGATE_RETENTION_MS);
    store.db.prepare("DELETE FROM ccp_usage_hour WHERE hour_ms < ?").run(nowMs - AGGREGATE_RETENTION_MS);
  })();
  nextPrune.set(store, nowMs + 600_000);
}

export function recordAdminSecurity(store: CcBridgeStore, eventType: string, memberId: string | undefined,
  targetId: string | undefined, result: "ok" | "deny" | "error", code?: string): void {
  store.db.prepare(`INSERT INTO ccp_security_event(timestamp_ms, actor_member_id, event_type, target_id, result_class, error_code)
    VALUES (?, ?, ?, ?, ?, ?)`).run(Date.now(), memberId?.slice(0, 128) ?? null, eventType,
    targetId?.slice(0, 128) ?? null, result, code ?? null);
}

/** Record only fixed route categories and identifiers; never bodies, headers, or URLs. */
export function observeAdminSecurity(store: CcBridgeStore): RequestHandler {
  return (req, res, next) => {
    const device = /^\/v1\/devices\/([^/]+)\/(approve|revoke)$/.exec(req.path);
    const grant = /^\/v1\/admin\/grants\/([^/]+)\/revoke$/.exec(req.path);
    const event = req.method !== "POST" ? undefined : device ? `device.${device[2]}`
      : grant ? "grant.revoke" : req.path === "/v1/admin/grants" ? "grant.create"
      : req.path === "/v1/devices/enroll" ? "device.enroll"
      : req.path === "/v1/devices/challenge" ? "device.challenge"
      : req.path === "/v1/admin/session" ? "admin.login" : undefined;
    res.once("finish", () => {
      const rejected = res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429;
      if (!event && !rejected) return;
      try {
        const candidate = device?.[1] ?? grant?.[1];
        const target = candidate && /^[a-zA-Z0-9-]{1,128}$/.test(candidate) ? candidate : undefined;
        recordAdminSecurity(store, event ?? "access.denied", req.toolAuth?.member_id, target,
          res.statusCode < 400 ? "ok" : res.statusCode >= 500 ? "error" : "deny",
          rejected ? res.statusCode === 429 ? "CCP_BUSY" : "CCP_AUTH_INVALID" : undefined);
        retainAdminMetadata(store);
      } catch { /* Post-response audit cannot change the original response. */ }
    });
    next();
  };
}
