import { createHash, sign, type KeyLike } from "crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import { performance } from "perf_hooks";
import { canonicalizeToBytes } from "./canonical-json";
import type { ProtectedRequest } from "./protocol";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_POINTERS = 512;
type Phase = "request-built" | "transport-send" | "transport-response" | "decision-verified" | "execution-start" | "execution-finish" | "result-serialized";
type Outcome = "completed" | "failed" | "denied" | "outcome-unknown";
type Kind = "execute" | "result" | "denied" | "failed";
interface Marker { label: string; value: string }
interface State {
  request: ProtectedRequest;
  started: number;
  phases: Partial<Record<Phase, number>>;
  sends: number;
  responses: number;
  responseBytes: number;
  responseSha256?: string;
  wire?: Buffer;
  executionSends?: number;
  executionResponses?: number;
  concurrent: boolean;
  callId?: string;
  commandCount?: number;
}

function privatePath(file: string): string {
  const target = resolve(file);
  const home = realpathSync(homedir());
  const parent = realpathSync(dirname(target));
  const within = relative(home, parent);
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) throw new Error("trace path must remain inside the user home");
  for (let cursor = dirname(target); ; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("trace path must not traverse links");
    if (dirname(cursor) === cursor) break;
  }
  return target;
}

/** Qualification only; failures invalidate evidence, never change tool outcomes. */
export class QualificationTraceRecorder {
  private readonly states = new Map<string, State>();
  private readonly errors = new Set<string>();
  private readonly markers: Marker[];
  private descriptor: number | undefined;
  private bytes = 0;
  private sends = 0;
  private responses = 0;

  private live: { runId: string; file: number; bytes: number; key: KeyLike; keyId: string; binding: unknown } | undefined;

  configureLive(key: KeyLike, keyId: string, binding: unknown): void {
    const runId = process.env.CCB_QUALIFICATION_LIVE_RUN_ID;
    const file = process.env.CCB_QUALIFICATION_LIVE_TRACE_PATH;
    if (!runId || !file) return;
    try {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error("invalid live run ID");
      this.live = { runId, file: openSync(privatePath(file), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600), bytes: 0, key, keyId, binding };
    } catch { this.errors.add("live-trace-setup-failed"); }
  }

  get liveRunId(): string | null { return this.live?.runId ?? null; }

  httpResult(callId: string, requestId: string | null, toolId: string, status: number, bytes: Buffer, finished: boolean): void {
    let screenshot: { bytes: number; sha256: string; mimeType: string } | null = null;
    if (status === 200 && (toolId === "captureSceneScreenshot" || toolId === "captureEditorScreenshot")) {
      try {
        const parsed = JSON.parse(bytes.toString("utf8"));
        const image = parsed?.tool === toolId && parsed?.data ? parsed.data : parsed;
        if (image?.type === "image" && typeof image.data === "string" && ["image/png", "image/jpeg"].includes(image.mimeType)) {
          const raw = Buffer.from(image.data, "base64");
          const valid = image.mimeType === "image/png" ? raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : raw[0] === 255 && raw[1] === 216 && raw[raw.length - 2] === 255 && raw[raw.length - 1] === 217;
          if (valid) screenshot = { bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), mimeType: image.mimeType };
        }
      } catch { /* Missing image remains unverified. */ }
    }
    this.liveEvent({ type: "http-result", callId, requestId, toolId, status, finished, screenshot,
      resultBoundary: "local-http-response-bytes", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      matchedMarkers: this.markers.filter(marker => bytes.includes(Buffer.from(marker.value))).map(marker => marker.label) });
  }
  executionCommands(id: string, count: number): void {
    const state = this.states.get(id);
    if (state) state.commandCount = count;
  }

  private liveEvent(event: Record<string, unknown>): void {
    if (!this.live) return;
    try {
      const payload = canonicalizeToBytes({ schemaVersion: 1, evidenceScope: "installed-live", runId: this.live.runId,
        binding: this.live.binding, evidenceErrors: [...this.errors], ...event });
      const signature = sign(null, Buffer.concat([Buffer.from("CCB1 installed-live-witness\n"), payload]), this.live.key).toString("base64");
      const line = Buffer.from(JSON.stringify({ keyId: this.live.keyId, payload: payload.toString("base64"), signature }) + "\n");
      if (line.length + this.live.bytes > MAX_BYTES || fstatSync(this.live.file).size !== this.live.bytes) throw new Error("live-trace-cap-or-writer-conflict");
      let offset = 0;
      while (offset < line.length) { const count = writeSync(this.live.file, line, offset, line.length - offset); if (!count) throw new Error("live-trace-write-failed"); offset += count; }
      this.live.bytes += line.length;
    } catch { this.errors.add("live-trace-recording-failed"); }
  }
  static fromEnv(): QualificationTraceRecorder | null {
    if (!process.env.CCB_QUALIFICATION_TRACE_PATH) return null;
    try { return new QualificationTraceRecorder(process.env.CCB_QUALIFICATION_TRACE_PATH, process.env.CCB_QUALIFICATION_MARKERS_PATH); }
    catch { return null; } // Missing trace cannot satisfy qualification; execution is unchanged.
  }

  constructor(file: string, markerFile?: string) {
    this.markers = [];
    if (markerFile) {
      const markerPath = privatePath(markerFile);
      const stat = lstatSync(markerPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error("invalid marker file");
      const raw: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
      if (!Array.isArray(raw) || raw.length > 32) throw new Error("invalid marker count");
      const labels = new Set<string>();
      for (const item of raw) {
        if (!item || typeof item.label !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.label)
          || labels.has(item.label) || typeof item.value !== "string" || Buffer.byteLength(item.value) < 8 || Buffer.byteLength(item.value) > 256) throw new Error("invalid marker");
        labels.add(item.label);
        this.markers.push({ label: item.label, value: item.value });
      }
    }
    this.descriptor = openSync(privatePath(file), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  }

  begin(request: ProtectedRequest, callId?: string): void {
    if (this.states.size >= 64 || this.states.has(request.requestId)) { this.errors.add("overlapping-request-id-or-capacity"); return; }
    for (const state of this.states.values()) state.concurrent = true;
    const started = performance.now();
    this.states.set(request.requestId, { request, callId, started, phases: { "request-built": started }, sends: 0, responses: 0, responseBytes: 0, concurrent: this.states.size > 0 });
  }

  phase(id: string, phase: Phase): void {
    const state = this.states.get(id);
    if (!state) return;
    state.phases[phase] = performance.now();
    if (phase === "execution-start") { state.executionSends = this.sends; state.executionResponses = this.responses; }
  }

  gatewayRequest(id: string, wire: Buffer): void {
    this.sends++;
    const state = this.states.get(id);
    if (!state) { this.errors.add("unbound-transport"); return; }
    state.sends++;
    state.wire = wire; // Existing bounded immutable transport buffer; no credential headers.
    this.phase(id, "transport-send");
  }

  gatewayResponse(id: string, bytes: number, wire?: Buffer): void {
    this.responses++;
    const state = this.states.get(id);
    if (!state) { this.errors.add("unbound-transport"); return; }
    state.responses++;
    state.responseBytes += bytes;
    if (wire) state.responseSha256 = createHash("sha256").update(wire).digest("hex");
    this.phase(id, "transport-response");
  }

  finish(id: string, outcome: Outcome, kind: Kind, totalIpc: number | null, observationIpc: number | null, result: unknown, errorCode?: string): void {
    const state = this.states.get(id);
    if (!state) return;
    this.states.delete(id);
    try {
      const decoded = canonicalizeToBytes(state.request);
      const resultBytes = outcome === "completed" ? Buffer.from(JSON.stringify(result), "utf8") : null;
      if (resultBytes) state.phases["result-serialized"] = performance.now();
      const jsonPointers: string[] = [];
      let pointerTruncated = false;
      const visit = (value: unknown, pointer: string, depth: number): void => {
        if (jsonPointers.length >= MAX_POINTERS || depth > 32) { pointerTruncated = true; return; }
        jsonPointers.push(pointer || "/");
        const entries = value && typeof value === "object" ? Object.entries(value) : [];
        for (const [key, child] of entries) {
          visit(child, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1);
          if (pointerTruncated) break;
        }
      };
      visit(state.request, "", 0);
      const text = decoded.toString("utf8");
      const wireMatches = state.wire && JSON.parse(state.wire.toString("utf8")).payload;
      if (typeof wireMatches !== "string" || !Buffer.from(wireMatches.replace(/-/g, "+").replace(/_/g, "/"), "base64").equals(decoded)) this.errors.add("wire-request-mismatch");
      const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      const record = {
        schemaVersion: 2, evidenceScope: "source-qualification", resultBoundary: "dispatch-result-json", clock: "monotonic-ms",
        traceComplete: this.errors.size === 0 && !pointerTruncated && !state.concurrent && totalIpc !== null && observationIpc !== null, evidenceErrors: [...this.errors],
        requestId: id, toolId: state.request.tool.id, kind, outcome, errorCode: errorCode ?? null,
        binding: { projectId: state.request.projectId, relayInstanceId: state.request.relayInstanceId, relay: state.request.relay },
        request: { wireBytes: state.wire?.length ?? 0, wireSha256: state.wire ? hash(state.wire) : null, decodedBytes: decoded.length,
          decodedSha256: hash(decoded), jsonPointers, pointerTruncated, matchedMarkers: this.markers.filter(m => text.includes(m.value)).map(m => m.label) },
        gateway: { requests: state.sends, responses: state.responses, responseBytes: state.responseBytes, responseSha256: state.responseSha256 ?? null, concurrent: state.concurrent,
          requestsDuringExecution: state.executionSends === undefined ? null : this.sends - state.executionSends,
          responsesDuringExecution: state.executionResponses === undefined ? null : this.responses - state.executionResponses },
        creator: { totalIpc, observationIpc, postGatewayIpc: totalIpc === null || observationIpc === null ? null : totalIpc - observationIpc },
        result: resultBytes ? { bytes: resultBytes.length, sha256: hash(resultBytes) } : null,
        phases: state.phases, durationMs: performance.now() - state.started,
        priorTelemetry: state.request.priorTelemetry ?? null,
        executionCommandCount: state.commandCount ?? null,
        inputSha256: hash(canonicalizeToBytes(state.request.inputs)),
        canarySources: {
          inputs: this.markers.filter(m => JSON.stringify(state.request.inputs).includes(m.value)).map(m => m.label),
          observation: this.markers.filter(m => state.request.observation && JSON.stringify(state.request.observation).includes(m.value)).map(m => m.label),
          result: this.markers.filter(m => resultBytes?.includes(Buffer.from(m.value))).map(m => m.label),
        },
      };
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      if (this.descriptor === undefined || line.length + this.bytes > MAX_BYTES || fstatSync(this.descriptor).size !== this.bytes) throw new Error("trace-cap-or-writer-conflict");
      let offset = 0;
      while (offset < line.length) { const written = writeSync(this.descriptor, line, offset, line.length - offset); if (!written) throw new Error("trace-write-failed"); offset += written; }
      this.bytes += line.length;
      this.liveEvent({ type: "protected-dispatch", callId: state.callId ?? null, record });
    } catch { this.errors.add("trace-recording-failed"); }
  }

  close(): void {
    if (this.descriptor !== undefined) { closeSync(this.descriptor); this.descriptor = undefined; }
    if (this.live) { closeSync(this.live.file); this.live = undefined; }
  }
}
