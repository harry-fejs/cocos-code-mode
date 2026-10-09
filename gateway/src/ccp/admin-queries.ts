import { z } from "zod";
import type { CcBridgeStore } from "./store.ts";
import { AGGREGATE_RETENTION_MS, DETAIL_RETENTION_MS, retainAdminMetadata } from "./admin-audit.ts";
import { CcpError } from "./errors.ts";
import { CCP_METRIC_PHASES } from "./metrics.ts";

const id = z.string().min(1).max(128).optional();
const QuerySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(), to: z.coerce.number().int().positive().optional(),
  memberId: id, deviceId: id, projectId: id, toolId: id, relayBuild: id, errorCode: id,
  result: z.enum(["ok", "deny", "error"]).optional(), status: z.enum(["pending", "approved", "revoked", "active", "disabled"]).optional(),
  groupBy: z.enum(["memberId", "deviceId", "projectId", "toolId", "relayBuild"]).default("toolId"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
const columns = { memberId: "member_id", deviceId: "device_id", projectId: "project_id", toolId: "tool_family", relayBuild: "relay_build", errorCode: "error_code", result: "result_class" } as const;
export function parseAdminQuery(raw: unknown) {
  const parsed = QuerySchema.parse(raw);
  const to = parsed.to ?? Date.now();
  const from = parsed.from ?? to - 86_400_000;
  if (from >= to || to - from > AGGREGATE_RETENTION_MS || to > Date.now() + 60_000) {
    throw new CcpError("CCP_CANONICAL_INVALID", "Choose an increasing date range of at most 90 days, not in the future.");
  }
  return { ...parsed, from, to };
}
type Query = z.infer<typeof QuerySchema> & { from: number; to: number };
function where(query: Query, time: "hour_ms" | "timestamp_ms") {
  const from = time === "hour_ms" ? query.from - query.from % 3_600_000 : query.from;
  const to = time === "hour_ms" ? Math.ceil(query.to / 3_600_000) * 3_600_000 : query.to;
  const clauses = [`${time} >= ?`, `${time} < ?`];
  const values: Array<string | number> = [from, to];
  for (const [key, column] of Object.entries(columns)) {
    const value = query[key as keyof typeof columns];
    if (value !== undefined) { clauses.push(`${column} = ?`); values.push(value); }
  }
  return { sql: clauses.join(" AND "), values, from, to };
}
const projection = `id, correlation_id AS correlationId, request_id AS requestId, timestamp_ms AS timestampMs, member_id AS memberId,
  device_id AS deviceId, project_id AS projectId, tool_family AS toolId, relay_build AS relayBuild,
  result_class AS gatewayResult, error_code AS errorCode, request_bytes AS requestBytes, response_bytes AS responseBytes`;
const PHASES = CCP_METRIC_PHASES;
function percentiles(values: number[]) {
  values.sort((a, b) => a - b);
  return { count: values.length, p50: values[Math.max(0, Math.ceil(values.length * .5) - 1)] ?? null,
    p95: values[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? null,
    p99: values[Math.max(0, Math.ceil(values.length * .99) - 1)] ?? null };
}
export function queryAdminAnalytics(store: CcBridgeStore, view: string, query: Query) {
  retainAdminMetadata(store);
  const detail = where(query, "timestamp_ms");
  const aggregate = where(query, "hour_ms");
  const base = { detailRetentionDays: DETAIL_RETENTION_MS / 86_400_000, aggregateRetentionDays: 90,
    creatorOutcome: "unknown", creatorTelemetry: "not-collected", from: query.from, to: query.to,
    aggregateFrom: aggregate.from, aggregateTo: aggregate.to, aggregateResolution: "hour" };
  if (view === "overview" || view === "usage") {
    const totals = store.db.prepare(`SELECT COALESCE(SUM(requests), 0) AS requests,
      COALESCE(SUM(CASE WHEN result_class = 'ok' THEN requests ELSE 0 END), 0) AS gatewaySigned,
      COALESCE(SUM(CASE WHEN result_class = 'deny' THEN requests ELSE 0 END), 0) AS gatewayDenied,
      COALESCE(SUM(CASE WHEN result_class = 'error' THEN requests ELSE 0 END), 0) AS gatewayErrors,
      COALESCE(SUM(request_bytes), 0) AS requestBytes, COALESCE(SUM(response_bytes), 0) AS responseBytes
      FROM ccp_usage_hour WHERE ${aggregate.sql}`).get(...aggregate.values) as Record<string, number>;
    const group = columns[query.groupBy];
    const rows = store.db.prepare(`SELECT ${group} AS dimension, SUM(requests) AS requests,
      SUM(CASE WHEN result_class = 'ok' THEN requests ELSE 0 END) AS gatewaySigned,
      SUM(CASE WHEN result_class != 'ok' THEN requests ELSE 0 END) AS rejected
      FROM ccp_usage_hour WHERE ${aggregate.sql} GROUP BY ${group}
      ORDER BY requests DESC, dimension LIMIT ? OFFSET ?`).all(...aggregate.values, query.limit + 1, query.offset);
    return { ...base, totals: { ...totals, gatewayRejectionRate: totals.requests ? (totals.gatewayDenied + totals.gatewayErrors) / totals.requests : 0 },
      groupBy: query.groupBy, rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  }
  if (view === "requests" || view === "errors") {
    const condition = view === "errors" ? " AND result_class != 'ok'" : "";
    const rows = store.db.prepare(`SELECT ${projection}, telemetry.outcome AS creatorOutcome,
        telemetry.duration_ms AS creatorDurationMs, telemetry.error_code AS creatorErrorCode
      FROM ccp_audit LEFT JOIN ccp_completion_telemetry AS telemetry ON telemetry.request_id = ccp_audit.request_id
      WHERE ${detail.sql}${condition}
      ORDER BY timestamp_ms DESC, id DESC LIMIT ? OFFSET ?`).all(...detail.values, query.limit + 1, query.offset);
    const facets = view === "errors" ? store.db.prepare(`SELECT error_code AS errorCode, COUNT(*) AS requests
      FROM ccp_audit WHERE ${detail.sql}${condition} GROUP BY error_code ORDER BY requests DESC LIMIT 50`)
      .all(...detail.values) : undefined;
    return { ...base, rows: rows.slice(0, query.limit).map((row) => ({ ...row as object, creatorOutcome: (row as { creatorOutcome?: string }).creatorOutcome ?? "unknown" })),
      facets, hasMore: rows.length > query.limit };
  }
  if (view === "latency") {
    const rows = store.db.prepare(`SELECT phase_timings_json AS timings FROM ccp_audit WHERE ${detail.sql}
      ORDER BY timestamp_ms DESC, id DESC LIMIT 10001`).all(...detail.values) as Array<{ timings: string }>;
    const values: Record<string, number[]> = Object.fromEntries([...PHASES, "gatewayTotal"].map((key) => [key, []]));
    let invalidRows = 0;
    for (const row of rows.slice(0, 10000)) {
      try {
        const timings = JSON.parse(row.timings) as Record<string, unknown>;
        let total = 0; let measured = false;
        for (const phase of PHASES) {
          const value = timings[phase];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) { values[phase].push(value); total += value; measured = true; }
        }
        if (measured) values.gatewayTotal.push(total); else invalidRows++;
      } catch { invalidRows++; }
    }
    return { ...base, rows: Object.entries(values).map(([phase, samples]) => ({ phase, ...percentiles(samples) })),
      sampledRequests: Math.min(rows.length, 10000), truncated: rows.length > 10000, invalidRows,
      measurement: "Recorded Gateway phases only; excludes network and Creator time. Latest 10000 matching requests maximum." };
  }
  if (view === "security") {
    // Identity-specific request filters apply to execute denials; lifecycle events have only actor/target metadata.
    const securityValues: Array<string | number> = [query.from, query.to];
    let securityWhere = "timestamp_ms >= ? AND timestamp_ms < ?";
    if (query.memberId) { securityWhere += " AND actor_member_id = ?"; securityValues.push(query.memberId); }
    if (query.deviceId) { securityWhere += " AND target_id = ?"; securityValues.push(query.deviceId); }
    if (query.errorCode) { securityWhere += " AND error_code = ?"; securityValues.push(query.errorCode); }
    if (query.result) { securityWhere += " AND result_class = ?"; securityValues.push(query.result); }
    if (query.projectId || query.toolId || query.relayBuild) securityWhere += " AND 0";
    const rows = store.db.prepare(`SELECT * FROM (
      SELECT id, timestamp_ms AS timestampMs, actor_member_id AS memberId, event_type AS event,
        target_id AS targetId, result_class AS result, error_code AS errorCode, 'lifecycle' AS source
        FROM ccp_security_event WHERE ${securityWhere}
      UNION ALL
      SELECT id, timestamp_ms, member_id, 'execute.denied', device_id, result_class, error_code, 'execute'
        FROM ccp_audit WHERE ${detail.sql} AND result_class != 'ok'
      ) ORDER BY timestampMs DESC, source, id DESC LIMIT ? OFFSET ?`)
      .all(...securityValues, ...detail.values, query.limit + 1, query.offset);
    return { ...base, rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit,
      coverage: "Lifecycle events since admin audit activation; execute denials retained 7 days. Early auth/rate denials omit unverified identity." };
  }
  if (view === "versions") {
    const rows = store.db.prepare(`SELECT tool_id AS toolId, contract_version AS contractVersion, enabled,
      contract_hash AS contractHash, minimum_relay_build AS minimumRelayBuild, creator_range AS creatorRange,
      required_consent_version AS requiredConsentVersion, revision FROM operation_policy
      ${query.toolId ? "WHERE tool_id = ?" : ""} ORDER BY tool_id, contract_version LIMIT ? OFFSET ?`)
      .all(...(query.toolId ? [query.toolId] : []), query.limit + 1, query.offset);
    return { ...base, rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit,
      coverage: "Configured compatibility policy, not proof of observed Creator version or completion." };
  }
  throw new CcpError("CCP_CANONICAL_INVALID", "Unknown admin analytics view.");
}

export function queryAdminInventory(store: CcBridgeStore, kind: "devices" | "grants", query: Query) {
  const clauses: string[] = []; const values: Array<string | number> = [];
  const filters = kind === "devices" ? { memberId: "member_id", deviceId: "id", status: "status" }
    : { memberId: "member_id", deviceId: "device_id", projectId: "project_id", toolId: "tool_id", status: "status" };
  for (const [key, column] of Object.entries(filters)) {
    const value = query[key as keyof typeof filters];
    if (value !== undefined) { clauses.push(`${column} = ?`); values.push(value); }
  }
  const fields = kind === "devices" ? `id, key_id AS keyId, member_id AS memberId, fingerprint, label, status,
    created_at_ms AS createdAtMs, last_seen_at_ms AS lastSeenAtMs, revoked_at_ms AS revokedAtMs`
    : `id, member_id AS memberId, device_id AS deviceId, project_id AS projectId, tool_id AS toolId,
      operation_class AS operationClass, expires_at_ms AS expiresAtMs, status, created_at_ms AS createdAtMs`;
  const rows = store.db.prepare(`SELECT ${fields} FROM ${kind === "devices" ? "device" : "grant_record"}
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at_ms DESC, id LIMIT ? OFFSET ?`)
    .all(...values, query.limit + 1, query.offset);
  return { [kind]: rows.slice(0, query.limit), hasMore: rows.length > query.limit, offset: query.offset };
}
