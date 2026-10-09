import { describe, expect, it } from "vitest";
import { recordCcBridgeAudit, type CcBridgeAuditRow } from "../../src/ccp/audit.ts";
import { ccpMetricsRegistry, recordCcBridgeExecute, recordCcBridgeRuntimeState } from "../../src/ccp/metrics.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";

describe("CCP audit", () => {
  it("stores metadata only — no observation, screenshot, or result body", () => {
    const store = new CcBridgeStore(":memory:");
    const row: CcBridgeAuditRow = {
      correlationId: "corr-1",
      memberId: "member-1",
      deviceId: "device-1",
      projectId: "project-1",
      toolFamily: "createUiNode",
      resultClass: "ok",
      requestBytes: 128,
      responseBytes: 256,
      phaseTimings: { authorize: 1, plan: 2 },
    };
    recordCcBridgeAudit(store, row, 1);
    const stored = store.db.prepare("SELECT * FROM ccp_audit").get() as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      "correlation_id", "device_id", "error_code", "id", "member_id",
      "phase_timings_json", "project_id", "relay_build", "request_bytes", "request_id",
      "response_bytes", "result_class", "timestamp_ms", "tool_family",
    ].sort());
    expect(JSON.stringify(stored)).not.toMatch(/observation|screenshot|parentUuid|scene-root/);
  });

  it("exports only bounded low-cardinality metric labels", async () => {
    ccpMetricsRegistry.resetMetrics();
    recordCcBridgeExecute("createUiNode", "ok", undefined, { plan: 5 });
    recordCcBridgeExecute("attacker-controlled-tool", "deny", "attacker-controlled-reason");
    recordCcBridgeRuntimeState({ signerAvailable: true, activeDevices: 3, replayEntries: 7 });
    const metrics = await ccpMetricsRegistry.metrics();
    expect(metrics).toContain('operation_class="mutation",result_class="ok",reason="none"');
    expect(metrics).toContain('operation_class="unknown",result_class="deny",reason="unknown"');
    expect(metrics).toContain('phase="plan"');
    expect(metrics).toContain('state="active_devices"} 3');
    expect(metrics).not.toContain("createUiNode");
    expect(metrics).not.toContain("attacker-controlled");
  });
});
