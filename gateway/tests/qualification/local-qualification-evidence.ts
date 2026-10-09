import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function delay(ms: number): Promise<void> {
  const deferred = Promise.withResolvers<void>();
  setTimeout(deferred.resolve, ms);
  return deferred.promise;
}
export function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
export function errorCode(error: unknown): string {
  const candidate = error as { body?: { code?: string }; code?: string; message?: string };
  const text = candidate?.body?.code ?? candidate?.code ?? candidate?.message ?? "QUALIFICATION_ERROR";
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(text) ? text : "QUALIFICATION_ERROR";
}
export function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, `INVALID_${name}`);
  return value;
}
export function digestFiles(paths: string[]): string {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) hash.update(path).update("\0").update(readFileSync(resolve(repository, path)));
  return hash.digest("hex");
}
export function percentiles(values: number[]): Record<string, number> {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), min: sorted[0], max: sorted[sorted.length - 1] };
}

// Only caller-constructed metadata is written: never requests, responses, JWTs,
// keys, signed wrappers, arbitrary errors, scene arguments or source text.
export class Evidence {
  readonly runId = randomUUID();
  readonly path: string;
  readonly identity = {
    node: process.version, os: process.platform, arch: process.arch, creator: null,
    creatorCompatibility: "3.7.3", transport: "loopback-http-not-production-tls",
    clients: "in-process-simulated-devices", creatorExecution: "simulated-adapter-not-Creator",
    packageIdentity: "source-digest-fixture-not-installed-ZIP",
    relaySourceSha256: digestFiles([
      "source/protected/decision-verifier.ts", "source/protected/primitive-executor.ts",
      "source/protected/protocol.ts", "source/protected/value-resolver.ts", "source/protected/schemas.ts",
    ]),
    gatewaySourceSha256: digestFiles([
      "gateway/src/ccp/execute-service.ts", "gateway/src/ccp/planners/plan-create-tools.ts",
      "gateway/src/ccp/release-admin.ts", "gateway/src/ccp/canary.ts",
    ]),
  };
  failed = 0;
  private fd: number;
  private bytes = 0;
  private rows = 0;
  constructor() {
    this.path = resolve(process.env.CCP_QUAL_EVIDENCE ?? `reports/evidence/local-qualification-${this.runId}.ndjson`);
    mkdirSync(dirname(this.path), { recursive: true });
    this.fd = openSync(this.path, "wx", 0o600);
    this.emit({ type: "identity", ...this.identity });
  }
  emit(record: Record<string, unknown>): void {
    const line = `${JSON.stringify({ runId: this.runId, at: new Date().toISOString(), ...record })}\n`;
    const bytes = Buffer.byteLength(line);
    invariant(bytes <= 16_384 && this.bytes + bytes <= 128 * 1024 * 1024 && this.rows < 100_000, "EVIDENCE_BOUND_EXCEEDED");
    writeSync(this.fd, line);
    this.bytes += bytes;
    this.rows += 1;
  }
  async scenario(name: string, run: () => Promise<Record<string, unknown>>): Promise<void> {
    const start = performance.now();
    this.emit({ type: "scenario-start", scenario: name });
    try {
      const details = await run();
      this.emit({ type: "scenario-result", scenario: name, pass: true, durationMs: performance.now() - start, ...details });
    } catch (error) {
      this.failed += 1;
      this.emit({ type: "scenario-result", scenario: name, pass: false, durationMs: performance.now() - start, errorCode: errorCode(error) });
    }
  }
  close(): void {
    this.emit({ type: "summary", pass: this.failed === 0, failedScenarios: this.failed, rows: this.rows, bytes: this.bytes });
    closeSync(this.fd);
    console.log(JSON.stringify({ evidence: this.path, runId: this.runId, pass: this.failed === 0, failedScenarios: this.failed }));
    if (this.failed) process.exitCode = 1;
  }
}
