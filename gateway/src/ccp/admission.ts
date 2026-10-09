import type { NextFunction, Request, RequestHandler, Response } from "express";
import { CcpError, toCcpErrorBody } from "./errors.ts";

interface WindowEntry {
  startedAt: number;
  count: number;
}

export interface AdmissionConfig {
  allowedHosts: ReadonlySet<string>;
  ipRequestsPerMinute: number;
  memberRequestsPerMinute: number;
  maxTrackedKeys: number;
  concurrentExecute: number;
  queuedExecute: number;
  queueTimeoutMs: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadAdmissionConfig(env: NodeJS.ProcessEnv = process.env): AdmissionConfig {
  const allowedHosts = new Set(
    (env.CCP_ALLOWED_HOSTS ?? "127.0.0.1,localhost")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedHosts.size === 0) throw new Error("CCP_ALLOWED_HOSTS must contain at least one hostname");
  return {
    allowedHosts,
    ipRequestsPerMinute: positiveInteger(env.CCP_IP_REQUESTS_PER_MINUTE, 240, "CCP_IP_REQUESTS_PER_MINUTE"),
    memberRequestsPerMinute: positiveInteger(env.CCP_MEMBER_REQUESTS_PER_MINUTE, 120, "CCP_MEMBER_REQUESTS_PER_MINUTE"),
    maxTrackedKeys: positiveInteger(env.CCP_MAX_TRACKED_RATE_KEYS, 10_000, "CCP_MAX_TRACKED_RATE_KEYS"),
    concurrentExecute: positiveInteger(env.CCP_MAX_CONCURRENT_EXECUTE, 64, "CCP_MAX_CONCURRENT_EXECUTE"),
    queuedExecute: positiveInteger(env.CCP_MAX_QUEUED_EXECUTE, 128, "CCP_MAX_QUEUED_EXECUTE"),
    queueTimeoutMs: positiveInteger(env.CCP_QUEUE_TIMEOUT_MS, 1_000, "CCP_QUEUE_TIMEOUT_MS"),
  };
}

class FixedWindowLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxTrackedKeys: number,
  ) {}

  allows(key: string, nowMs = Date.now()): boolean {
    const current = this.entries.get(key);
    if (current && nowMs - current.startedAt < this.windowMs) {
      current.count += 1;
      return current.count <= this.limit;
    }
    if (!current && this.entries.size >= this.maxTrackedKeys) {
      for (const [candidate, entry] of this.entries) {
        if (nowMs - entry.startedAt >= this.windowMs) this.entries.delete(candidate);
      }
      if (this.entries.size >= this.maxTrackedKeys) return false;
    }
    this.entries.set(key, { startedAt: nowMs, count: 1 });
    return true;
  }
}

interface QueuedRequest {
  resolve: (release: () => void) => void;
  reject: (error: CcpError) => void;
  timer: NodeJS.Timeout;
}

class ExecuteSemaphore {
  private active = 0;
  private readonly queue: QueuedRequest[] = [];

  constructor(
    private readonly concurrent: number,
    private readonly maxQueued: number,
    private readonly timeoutMs: number,
  ) {}

  acquire(): Promise<() => void> {
    if (this.active < this.concurrent) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new CcpError("CCP_BUSY", "Gateway execute queue is full."));
    }
    const deferred = Promise.withResolvers<() => void>();
    let queued!: QueuedRequest;
    const timer = setTimeout(() => {
      const index = this.queue.indexOf(queued);
      if (index >= 0) this.queue.splice(index, 1);
      deferred.reject(new CcpError("CCP_BUSY", "Gateway execute queue deadline elapsed."));
    }, this.timeoutMs);
    queued = {
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer,
    };
    this.queue.push(queued);
    return deferred.promise;
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queued = this.queue.shift();
      if (queued) {
        clearTimeout(queued.timer);
        queued.resolve(this.releaseOnce());
        return;
      }
      this.active -= 1;
    };
  }
}

function deny(res: Response, status: number, error: CcpError): void {
  res.status(status).json(toCcpErrorBody(error));
}

export interface GatewayAdmission {
  enforceHostAndIp: RequestHandler;
  enforceMemberRate: RequestHandler;
  enforceExecuteConcurrency: RequestHandler;
}

export function createGatewayAdmission(config: AdmissionConfig = loadAdmissionConfig()): GatewayAdmission {
  const ipLimiter = new FixedWindowLimiter(config.ipRequestsPerMinute, 60_000, config.maxTrackedKeys);
  const memberLimiter = new FixedWindowLimiter(config.memberRequestsPerMinute, 60_000, config.maxTrackedKeys);
  const semaphore = new ExecuteSemaphore(config.concurrentExecute, config.queuedExecute, config.queueTimeoutMs);

  return {
    enforceHostAndIp(req: Request, res: Response, next: NextFunction): void {
      const host = (req.hostname || "").toLowerCase();
      if (!config.allowedHosts.has(host)) {
        deny(res, 400, new CcpError("CCP_AUTH_INVALID", "Request Host is not permitted."));
        return;
      }
      if (!ipLimiter.allows(req.ip || "unknown")) {
        deny(res, 429, new CcpError("CCP_BUSY", "Gateway IP request limit exceeded."));
        return;
      }
      next();
    },
    enforceMemberRate(req: Request, res: Response, next: NextFunction): void {
      const memberId = req.toolAuth?.member_id;
      if (!memberId) {
        deny(res, 401, new CcpError("CCP_AUTH_REQUIRED", "Member authentication is required."));
        return;
      }
      if (!memberLimiter.allows(memberId)) {
        deny(res, 429, new CcpError("CCP_BUSY", "Gateway member request limit exceeded."));
        return;
      }
      next();
    },
    async enforceExecuteConcurrency(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const release = await semaphore.acquire();
        res.once("finish", release);
        res.once("close", release);
        next();
      } catch (error) {
        deny(res, 429, error instanceof CcpError ? error : new CcpError("CCP_BUSY", "Gateway execute admission failed."));
      }
    },
  };
}
