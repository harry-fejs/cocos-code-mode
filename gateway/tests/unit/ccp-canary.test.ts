import { describe, expect, it } from "vitest";
import { assertCanaryPromotion, nextCanaryCohort, recordVerifiedCanaryHealth } from "../../src/ccp/canary.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";

describe("CCP canary 1→3→10", () => {
  it("selects the next cohort from healthy device count", () => {
    expect(nextCanaryCohort(0)).toBe(1);
    expect(nextCanaryCohort(1)).toBe(3);
    expect(nextCanaryCohort(3)).toBe(10);
    expect(nextCanaryCohort(10)).toBe("ga");
  });

  it("rejects skipped and backward promotions", () => {
    expect(() => assertCanaryPromotion(1, 10)).toThrow(/1→3→10/);
    expect(() => assertCanaryPromotion(3, 1)).toThrow(/1→3→10/);
    expect(() => assertCanaryPromotion(1, 3)).not.toThrow();
    expect(() => assertCanaryPromotion(3, 10)).not.toThrow();
  });

  it("persists target-, package-, ring-, device-, and probe-bound health evidence", () => {
    const store = new CcBridgeStore(":memory:");
    recordVerifiedCanaryHealth(store, {
      targetHash: "a".repeat(64),
      packageHash: "b".repeat(64),
      deviceId: "device-1",
      probeId: "utcp-active-compatible-protected-v1",
      observedAtMs: 1234,
      ring: "1",
      healthy: true,
    });
    expect(store.getCanaryHealth({
      targetHash: "a".repeat(64), packageHash: "b".repeat(64), ring: "1",
    })).toMatchObject([{
      deviceId: "device-1", probeId: "utcp-active-compatible-protected-v1", healthy: true,
    }]);
  });
});
