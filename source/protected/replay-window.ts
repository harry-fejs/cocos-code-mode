import { CcpError } from "./errors";

interface ConsumedDecision {
  digest: string;
  sequence: number;
  expiresAtMs: number;
}

export type ReplayAdmission = "new" | "exact-duplicate";

export class ReplayWindow {
  private next = 0;
  private readonly consumedByNonce = new Map<string, ConsumedDecision>();
  private readonly consumedDigests = new Map<string, number>();

  constructor(initialSequence = 0) {
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) throw new RangeError("initial sequence must be a non-negative safe integer");
    this.next = initialSequence;
  }

  nextSequence(): number {
    if (!Number.isSafeInteger(this.next + 1)) throw new CcpError("CCP_LIMIT_EXCEEDED", "Relay sequence exhausted.");
    this.next += 1;
    return this.next;
  }

  admitDecision(nonce: string, sequence: number, digest: string, expiresAtMs: number, nowMs = Date.now()): ReplayAdmission {
    this.prune(nowMs);
    const byNonce = this.consumedByNonce.get(nonce);
    const digestExpiry = this.consumedDigests.get(digest);
    if (byNonce) {
      if (byNonce.digest === digest && byNonce.sequence === sequence) return "exact-duplicate";
      throw new CcpError("CCP_REPLAY", "Decision nonce was already consumed with different signed bytes.", { sequence });
    }
    if (digestExpiry !== undefined) {
      throw new CcpError("CCP_REPLAY", "Decision payload was replayed under a different nonce.", { sequence });
    }
    this.consumedByNonce.set(nonce, { digest, sequence, expiresAtMs });
    this.consumedDigests.set(digest, expiresAtMs);
    return "new";
  }

  private prune(nowMs: number): void {
    for (const [nonce, value] of this.consumedByNonce) {
      if (value.expiresAtMs < nowMs) this.consumedByNonce.delete(nonce);
    }
    for (const [digest, expiresAtMs] of this.consumedDigests) {
      if (expiresAtMs < nowMs) this.consumedDigests.delete(digest);
    }
  }
}
