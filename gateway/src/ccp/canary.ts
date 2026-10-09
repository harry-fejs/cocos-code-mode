import { CcpError } from "./errors.ts";
import type { CanaryHealthRecord, CanaryRing, CcBridgeStore, RolloutStateRecord } from "./store.ts";

export const CANARY_COHORTS = [1, 3, 10] as const;
export type CanaryCohort = (typeof CANARY_COHORTS)[number] | "ga";
export const CANARY_MIN_SOAK_MS = 15 * 60_000;
export const CANARY_HEALTH_MAX_AGE_MS = 5 * 60_000;

export function nextCanaryCohort(healthyDevices: number): CanaryCohort {
  if (healthyDevices < 1) return 1;
  if (healthyDevices < 3) return 3;
  if (healthyDevices < 10) return 10;
  return "ga";
}

export function assertCanaryPromotion(from: CanaryCohort, to: CanaryCohort): void {
  const order: CanaryCohort[] = [1, 3, 10, "ga"];
  if (order.indexOf(to) !== order.indexOf(from) + 1) {
    throw new CcpError("CCP_DEVICE_DENIED", `Canary must promote 1→3→10→ga, not ${String(from)}→${String(to)}.`);
  }
}

export interface CanaryPromotionInput {
  channel: string;
  targetHash: string;
  packageHash: string;
  ring: CanaryRing;
  policySequence: number;
  nowMs: number;
}

export function assertDurableCanaryPromotion(store: CcBridgeStore, input: CanaryPromotionInput): RolloutStateRecord | null {
  const current = store.getRolloutState(input.channel);
  if (!current || current.targetHash !== input.targetHash || current.packageHash !== input.packageHash) {
    if (input.ring !== "1") {
      throw new CcpError("CCP_DEVICE_DENIED", "A new release target must begin in canary ring 1.");
    }
    return current;
  }
  const currentRing = Number(current.ring);
  const requestedRing = Number(input.ring);
  if (requestedRing < currentRing) {
    throw new CcpError("CCP_DEVICE_DENIED", "Canary rollout cannot move backward.");
  }
  if (requestedRing === currentRing) return current;
  assertCanaryPromotion(currentRing as 1 | 3 | 10, requestedRing as 1 | 3 | 10);
  if (input.nowMs - current.updatedAtMs < CANARY_MIN_SOAK_MS) {
    throw new CcpError("CCP_DEVICE_DENIED", "Canary cohort has not completed the required soak period.");
  }
  const health = store.getCanaryHealth({
    targetHash: input.targetHash,
    packageHash: input.packageHash,
    ring: current.ring,
    sinceMs: Math.max(current.updatedAtMs, input.nowMs - CANARY_HEALTH_MAX_AGE_MS),
  });
  if (health.some((record) => !record.healthy)) {
    throw new CcpError("CCP_DEVICE_DENIED", "Canary cohort contains an unhealthy protected-path probe.");
  }
  const healthyDevices = new Set(health.map((record) => record.deviceId));
  if (healthyDevices.size < currentRing) {
    throw new CcpError("CCP_DEVICE_DENIED", `Canary ring ${current.ring} requires ${currentRing} recently healthy devices.`);
  }
  return current;
}

export function recordVerifiedCanaryHealth(store: CcBridgeStore, record: CanaryHealthRecord): void {
  if (!record.targetHash || !record.packageHash || !record.deviceId || !record.probeId
    || !Number.isSafeInteger(record.observedAtMs) || record.observedAtMs < 0) {
    throw new CcpError("CCP_CANONICAL_INVALID", "Canary health evidence is incomplete.");
  }
  store.recordCanaryHealth(record);
}
