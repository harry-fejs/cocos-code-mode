import type { CcBridgeStore } from "./store.ts";
import { retainAdminMetadata } from "./admin-audit.ts";

export interface CcBridgeAuditRow {
  correlationId: string;
  requestId?: string;
  memberId?: string;
  deviceId?: string;
  projectId?: string;
  toolFamily: string;
  relayBuild?: string;
  resultClass: "ok" | "deny" | "error";
  errorCode?: string;
  requestBytes: number;
  responseBytes: number;
  phaseTimings: Record<string, number>;
}

export function recordCcBridgeAudit(store: CcBridgeStore, row: CcBridgeAuditRow, nowMs = Date.now()): void {
  store.db.transaction(() => {
    store.db.prepare(`
      INSERT INTO ccp_audit(
        correlation_id, request_id, timestamp_ms, member_id, device_id, project_id, tool_family,
        relay_build, result_class, error_code, request_bytes, response_bytes, phase_timings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.correlationId, row.requestId ?? null, nowMs, row.memberId ?? null, row.deviceId ?? null, row.projectId ?? null,
      row.toolFamily, row.relayBuild ?? null, row.resultClass, row.errorCode ?? null,
      row.requestBytes, row.responseBytes, JSON.stringify(row.phaseTimings),
    );
    store.db.prepare(`INSERT INTO ccp_usage_hour
      (hour_ms, member_id, device_id, project_id, tool_family, relay_build, result_class, error_code, requests, request_bytes, response_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT DO UPDATE SET requests = requests + 1,
        request_bytes = request_bytes + excluded.request_bytes, response_bytes = response_bytes + excluded.response_bytes
    `).run(nowMs - nowMs % 3_600_000, row.memberId ?? "", row.deviceId ?? "", row.projectId ?? "",
      row.toolFamily, row.relayBuild ?? "", row.resultClass, row.errorCode ?? "", row.requestBytes, row.responseBytes);
  })();
  retainAdminMetadata(store, nowMs);
}

export interface CcBridgeCompletionTelemetry {
  requestId: string;
  outcome: "completed" | "failed" | "outcome-unknown";
  durationMs: number;
  errorCode?: string;
}

export function recordCcBridgeCompletionTelemetry(store: CcBridgeStore, records: readonly CcBridgeCompletionTelemetry[], nowMs = Date.now()): void {
  if (records.length === 0) return;
  store.db.transaction(() => {
    const insert = store.db.prepare(`
      INSERT INTO ccp_completion_telemetry(request_id, outcome, duration_ms, error_code, received_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        outcome = excluded.outcome,
        duration_ms = excluded.duration_ms,
        error_code = excluded.error_code,
        received_at_ms = excluded.received_at_ms
      WHERE excluded.received_at_ms >= ccp_completion_telemetry.received_at_ms
    `);
    for (const record of records.slice(-16)) {
      insert.run(record.requestId, record.outcome, record.durationMs, record.errorCode ?? null, nowMs);
    }
  })();
  retainAdminMetadata(store, nowMs);
}
