import client from "prom-client";
import { CCP_ERROR_CODES, type CcpErrorCode } from "./errors.ts";
import { TOOL_CLASS } from "./tool-catalog.ts";

export const CCP_METRIC_PHASES = [
  "verify", "authorize", "plan", "validate", "sign", "persist",
] as const;
export type CcpMetricPhase = typeof CCP_METRIC_PHASES[number];

export const ccpMetricsRegistry = new client.Registry();

const executeTotal = new client.Counter({
  name: "ccp_execute_total",
  help: "Protected execute outcomes by finite operation class and result class.",
  labelNames: ["operation_class", "result_class", "reason"] as const,
  registers: [ccpMetricsRegistry],
});

const phaseDuration = new client.Histogram({
  name: "ccp_execute_phase_seconds",
  help: "Protected execute server phase duration.",
  labelNames: ["phase"] as const,
  buckets: [0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [ccpMetricsRegistry],
});

const runtimeState = new client.Gauge({
  name: "ccp_runtime_state",
  help: "Current bounded CCP runtime state.",
  labelNames: ["state"] as const,
  registers: [ccpMetricsRegistry],
});


export function recordCcBridgeExecute(
  toolId: string,
  resultClass: "ok" | "deny" | "error",
  errorCode?: string,
  timings: Partial<Record<CcpMetricPhase, number>> = {},
): void {
  executeTotal.inc({
    operation_class: TOOL_CLASS[toolId] ?? "unknown",
    result_class: resultClass,
    reason: !errorCode
      ? "none"
      : CCP_ERROR_CODES.includes(errorCode as CcpErrorCode) ? errorCode : "unknown",
  });
  for (const phase of CCP_METRIC_PHASES) {
    const milliseconds = timings[phase];
    if (milliseconds !== undefined && Number.isFinite(milliseconds) && milliseconds >= 0) {
      phaseDuration.observe({ phase }, milliseconds / 1_000);
    }
  }
}

export function recordCcBridgeRuntimeState(state: {
  signerAvailable: boolean;
  activeDevices: number;
  replayEntries: number;
}): void {
  runtimeState.set({ state: "signer_available" }, state.signerAvailable ? 1 : 0);
  runtimeState.set({ state: "active_devices" }, state.activeDevices);
  runtimeState.set({ state: "replay_entries" }, state.replayEntries);
}
