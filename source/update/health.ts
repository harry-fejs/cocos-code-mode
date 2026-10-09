import { setTimeout as scheduleTimeout, clearTimeout } from "timers"
import type { RelayState } from "../protected/state-machine";
import { CcpError } from "../protected/errors";

export type UpdateHealthFailure =
  | "utcp-not-ready"
  | "relay-not-active"
  | "identity-incompatible"
  | "package-incompatible"
  | "creator-incompatible"
  | "protected-probe-failed"
  | "protected-probe-timeout";

export interface UpdateHealthInput {
  utcpReady: boolean;
  relayState: RelayState;
  identityCompatible: boolean;
  packageCompatible: boolean;
  creatorCompatible: boolean;
  protectedProbeTimeoutMs: number;
  protectedProbe: () => Promise<boolean>;
}

export interface UpdateHealthResult {
  healthy: boolean;
  failures: readonly UpdateHealthFailure[];
  probeDurationMs?: number;
}

export async function evaluateUpdateHealth(input: UpdateHealthInput): Promise<UpdateHealthResult> {
  if (!Number.isSafeInteger(input.protectedProbeTimeoutMs)
    || input.protectedProbeTimeoutMs < 1
    || input.protectedProbeTimeoutMs > 30_000) {
    throw new CcpError("CCP_CANONICAL_INVALID", "Protected update-health probe timeout must be between 1 and 30000 ms.");
  }
  const failures: UpdateHealthFailure[] = [];
  if (!input.utcpReady) failures.push("utcp-not-ready");
  if (input.relayState !== "ACTIVE") failures.push("relay-not-active");
  if (!input.identityCompatible) failures.push("identity-incompatible");
  if (!input.packageCompatible) failures.push("package-incompatible");
  if (!input.creatorCompatible) failures.push("creator-incompatible");
  if (failures.length > 0) return { healthy: false, failures };

  const startedAt = Date.now();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let probeOutcome: "passed" | "failed" | "timeout";
  try {
    probeOutcome = await Promise.race([
      input.protectedProbe().then((ok) => ok ? "passed" as const : "failed" as const).catch(() => "failed" as const),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = scheduleTimeout(() => resolve("timeout"), input.protectedProbeTimeoutMs);
      }),
    ]);
  } catch {
    probeOutcome = "failed";
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  const probeDurationMs = Date.now() - startedAt;
  if (probeOutcome === "passed") return { healthy: true, failures, probeDurationMs };
  failures.push(probeOutcome === "timeout" ? "protected-probe-timeout" : "protected-probe-failed");
  return { healthy: false, failures, probeDurationMs };
}
