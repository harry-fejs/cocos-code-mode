import { CcpError, CcpErrorCode } from "./errors";

export type RelayState = "BOOTING" | "LOCKED" | "ACTIVE" | "DRAINING";

export interface RelayLockReason {
  code: CcpErrorCode;
  error: string;
  details?: Record<string, null | boolean | number | string>;
}

export class ProtectedRelayStateMachine {
  private current: RelayState = "BOOTING";
  private lockReason: RelayLockReason = {
    code: "CCP_GATEWAY_UNAVAILABLE",
    error: "Protected relay is still booting.",
  };
  private activeWork = 0;
  private drainWaiters = new Set<() => void>();

  get state(): RelayState { return this.current; }
  get inFlight(): number { return this.activeWork; }
  get reason(): RelayLockReason | undefined {
    return this.current === "LOCKED" || this.current === "BOOTING" ? this.lockReason : undefined;
  }

  finishBootLocked(reason: RelayLockReason = this.lockReason): void {
    if (this.current !== "BOOTING") throw new Error(`cannot finish boot from ${this.current}`);
    this.lockReason = reason;
    this.current = "LOCKED";
  }

  activate(): void {
    if (this.current !== "LOCKED") throw new Error(`cannot activate relay from ${this.current}`);
    this.current = "ACTIVE";
  }

  lock(reason: RelayLockReason): void {
    if (this.current === "DRAINING") return;
    if (this.current !== "BOOTING" && this.current !== "LOCKED" && this.current !== "ACTIVE") {
      throw new Error(`cannot lock relay from ${this.current}`);
    }
    this.lockReason = reason;
    this.current = "LOCKED";
  }

  beginWork(): () => void {
    this.assertActive();
    this.activeWork += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeWork -= 1;
      if (this.activeWork === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    };
  }

  assertActive(): void {
    if (this.current === "ACTIVE") return;
    if (this.current === "DRAINING") {
      throw new CcpError("CCP_BUSY", "Protected relay is draining and rejects new work.", { state: this.current });
    }
    throw new CcpError(this.lockReason.code, this.lockReason.error, {
      state: this.current,
      ...(this.lockReason.details ?? {}),
    });
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError("drain timeout must be a non-negative integer");
    this.current = "DRAINING";
    if (this.activeWork === 0) return true;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drainWaiters.delete(onDrained);
        resolve(drained);
      };
      const onDrained = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.drainWaiters.add(onDrained);
    });
  }
}
