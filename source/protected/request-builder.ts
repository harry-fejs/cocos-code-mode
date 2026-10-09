import { KeyLike, createHash, randomBytes } from "crypto";
import { assertIJson, canonicalizeToBytes, IJson } from "./canonical-json";
import {
  OBSERVATION_MAX_BYTES, ProtectedRequest, SignedProtectedRequest, signProtectedRequest,
} from "./protocol";
import { parseProtectedRequest } from "./schemas";
import type { CompletionTelemetry } from "./protocol";
import { encodeBase64Url, randomUUID } from "./node14-compat";
import { CcpError } from "./errors";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

export interface ToolRequestBinding {
  id: string;
  contractVersion: number;
  contractHash: string;
}

export interface RelayRequestBinding {
  build: string;
  packageHash: string;
  creatorVersion: string;
  os: string;
}

export interface ProtectedObservation {
  contractId: string;
  consentVersion: string;
  revisionToken: string;
  digest: string;
  fields: IJson;
}

export interface BuildProtectedRequestOptions {
  deviceKeyId: string;
  deviceId: string;
  projectId: string;
  relayInstanceId: string;
  sequence: number;
  tool: ToolRequestBinding;
  relay: RelayRequestBinding;
  inputs: IJson;
  observation?: ProtectedObservation;
  priorTelemetry?: CompletionTelemetry[];
  idempotencyKey?: string;
  nowMs?: number;
  privateKey: KeyLike;
}

export interface BuiltProtectedRequest {
  request: ProtectedRequest;
  signed: SignedProtectedRequest;
  wrapperBytes: Buffer;
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new CcpError("CCP_CANONICAL_INVALID", "Idempotency key must be 16-128 base64url characters.");
  }
}

export function canonicalToolInputDigest(tool: ToolRequestBinding, inputs: IJson): string {
  assertIJson(inputs);
  return createHash("sha256").update(canonicalizeToBytes({ tool, inputs })).digest("hex");
}

interface CachedRequest {
  bindingDigest: string;
  built: Promise<BuiltProtectedRequest>;
}

/** Bounded per-relay cache. A key is installed before asynchronous observation reads begin. */
export class SignedRequestCache {
  private readonly entries = new Map<string, CachedRequest>();

  constructor(private readonly maxEntries = 256) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("request cache size must be positive");
  }

  async getOrBuild(
    idempotencyKey: string,
    bindingDigest: string,
    build: () => Promise<BuiltProtectedRequest>,
  ): Promise<BuiltProtectedRequest> {
    assertIdempotencyKey(idempotencyKey);
    const existing = this.entries.get(idempotencyKey);
    if (existing) {
      if (existing.bindingDigest !== bindingDigest) {
        throw new CcpError("CCP_IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to different canonical tool input bytes.");
      }
      return existing.built;
    }

    const promise = build();
    this.entries.set(idempotencyKey, { bindingDigest, built: promise });
    try {
      const result = await promise;
      this.prune();
      return result;
    } catch (error) {
      const current = this.entries.get(idempotencyKey);
      if (current?.built === promise) this.entries.delete(idempotencyKey);
      throw error;
    }
  }

  private prune(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

export function buildProtectedRequest(options: BuildProtectedRequestOptions): BuiltProtectedRequest {
  const nowMs = options.nowMs ?? Date.now();
  assertIJson(options.inputs);
  if (options.idempotencyKey !== undefined) assertIdempotencyKey(options.idempotencyKey);
  if (options.observation) {
    assertIJson(options.observation.fields);
    const observationBytes = canonicalizeToBytes(options.observation);
    if (observationBytes.byteLength > OBSERVATION_MAX_BYTES) {
      throw new CcpError("CCP_LIMIT_EXCEEDED", `Observation exceeds ${OBSERVATION_MAX_BYTES} bytes.`);
    }
  }

  const request: ProtectedRequest = {
    protocolVersion: 1,
    requestId: randomUUID(),
    idempotencyKey: options.idempotencyKey ?? encodeBase64Url(randomBytes(24)),
    deviceId: options.deviceId,
    projectId: options.projectId,
    relayInstanceId: options.relayInstanceId,
    sequence: options.sequence,
    issuedAtMs: nowMs,
    nonce: encodeBase64Url(randomBytes(16)),
    tool: { ...options.tool },
    relay: { ...options.relay },
    inputs: options.inputs,
    ...(options.observation ? { observation: options.observation } : {}),
    ...(options.priorTelemetry && options.priorTelemetry.length > 0 ? { priorTelemetry: options.priorTelemetry } : {}),
  };
  parseProtectedRequest(request, nowMs);
  const signed = signProtectedRequest(options.deviceKeyId, request, options.privateKey);
  return { request, signed, wrapperBytes: canonicalizeToBytes(signed) };
}
