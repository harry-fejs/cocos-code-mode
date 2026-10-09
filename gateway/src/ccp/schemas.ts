import { z } from "zod";
import { EffectSchema, ExecutionEnvelopeSchema, PUBLIC_PRIMITIVE_IDS, PUBLIC_VALUE_SOURCES } from "./primitive-contract";
import {
  BASE64URL_PATTERN, CLOCK_SKEW_MAX_MS, DECISION_LIFETIME_MAX_MS, KEY_ID_PATTERN,
  PRIOR_TELEMETRY_MAX_RECORDS, ProtectedRequest, GatewayDecision, SignedGatewayDecision,
  SignedProtectedRequest,
} from "./protocol";

const boundedText = (max: number) => z.string().min(1).max(max);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const opaqueId = z.string().uuid();
const base64url = z.string().min(1).max(700_000).regex(BASE64URL_PATTERN);
const toolBinding = z.object({ id: identifier, contractVersion: z.number().int().min(1), contractHash: hash }).strict();
const relayBinding = z.object({ build: boundedText(128), packageHash: hash }).strict();

export const SignedProtectedRequestSchema = z.object({
  deviceKeyId: z.string().regex(KEY_ID_PATTERN), payload: base64url, signature: base64url,
}).strict();

export const SignedGatewayDecisionSchema = z.object({
  executionKeyId: z.string().regex(KEY_ID_PATTERN), payload: base64url, signature: base64url,
}).strict();

const telemetry = z.object({
  requestId: opaqueId,
  outcome: z.enum(["completed", "failed", "outcome-unknown"]),
  durationMs: z.number().int().min(0).max(300_000),
  errorCode: boundedText(64).optional(),
}).strict();

export const ProtectedRequestSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: opaqueId,
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  deviceId: opaqueId,
  projectId: opaqueId,
  relayInstanceId: opaqueId,
  sequence: z.number().int().nonnegative().safe(),
  issuedAtMs: z.number().int().positive().safe(),
  nonce: z.string().length(22).regex(BASE64URL_PATTERN),
  tool: toolBinding,
  relay: relayBinding.extend({ creatorVersion: boundedText(64), os: boundedText(64) }).strict(),
  inputs: z.unknown(),
  observation: z.object({
    contractId: identifier, consentVersion: identifier, revisionToken: boundedText(512), digest: hash, fields: z.unknown(),
  }).strict().optional(),
  priorTelemetry: z.array(telemetry).max(PRIOR_TELEMETRY_MAX_RECORDS).optional(),
}).strict();

export const DecisionBindingSchema = z.object({
  requestId: opaqueId,
  deviceId: opaqueId,
  projectId: opaqueId,
  relayInstanceId: opaqueId,
  nonce: z.string().length(22).regex(BASE64URL_PATTERN),
  sequence: z.number().int().nonnegative().safe(),
  tool: toolBinding,
  relay: relayBinding,
  creatorRange: boundedText(128),
  issuedAtMs: z.number().int().positive().safe(),
  expiresAtMs: z.number().int().positive().safe(),
}).strict().superRefine((binding, context) => {
  const lifetime = binding.expiresAtMs - binding.issuedAtMs;
  if (lifetime <= 0 || lifetime > DECISION_LIFETIME_MAX_MS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid decision lifetime", path: ["expiresAtMs"] });
  }
});

const finiteResult = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), value: z.enum(["ok", "accepted", "unchanged"]) }).strict(),
  z.object({ type: z.literal("request-value"), jsonPointer: boundedText(1024) }).strict(),
  z.object({ type: z.literal("observation-value"), jsonPointer: boundedText(1024) }).strict(),
]);
const decisionLimits = z.object({ outputBytes: z.number().int().min(0).max(524_288), expiresInMs: z.number().int().min(1).max(DECISION_LIFETIME_MAX_MS) }).strict();

export const GatewayDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("result"), binding: DecisionBindingSchema, result: finiteResult, limits: decisionLimits, correlationId: opaqueId }).strict(),
  z.object({ kind: z.literal("execute"), binding: DecisionBindingSchema, envelope: ExecutionEnvelopeSchema, correlationId: opaqueId }).strict(),
]);

const PublicObservationSchema = z.object({
  contractId: identifier,
  consentVersion: identifier,
  fields: z.array(identifier).max(32),
}).strict();

const PublicDataFieldSchema = z.object({
  jsonPointer: z.string().min(1).max(1024).regex(/^\//),
  dataClass: z.enum(["project-metadata", "public-metadata", "local-payload"]),
  maxBytes: z.number().int().positive().max(10 * 1024 * 1024),
  retention: z.literal("none"),
  provenance: z.array(z.enum(["request", "creator-ipc", "local-derived"])).min(1).max(4),
  gatewayTransfer: z.enum(["allowed", "never"]),
}).strict();

const PublicOperationContractSchema = z.object({
  effect: EffectSchema,
  observation: PublicObservationSchema,
  primitives: z.array(z.enum(PUBLIC_PRIMITIVE_IDS)).min(1).max(16),
  resultMode: z.enum(["command-result", "command-results", "execution-summary"]),
}).strict();

export const PublicToolBehaviorSchema = z.object({
  name: identifier,
  contractVersion: z.number().int().positive(),
  compatibility: z.enum(["preserve", "breaking"]),
  creatorRange: boundedText(128),
  minimumRelayBuild: boundedText(128),
  plannerId: identifier,
  primitiveAbiVersion: z.literal(2),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  allowedInputFields: z.array(identifier).max(128),
  inputFields: z.array(PublicDataFieldSchema).max(128),
  outputFields: z.array(PublicDataFieldSchema).min(1).max(128),
  resultLocation: z.literal("relay-local"),
  gatewayResponsePolicy: z.literal("finite-contract-values-only"),
  allowedValueSources: z.array(z.enum(PUBLIC_VALUE_SOURCES)).min(1).max(PUBLIC_VALUE_SOURCES.length),
  publicConstants: z.record(z.string(), z.unknown()),
  operations: z.record(z.string().min(1).max(128).regex(/^[A-Za-z0-9._:*-]+$/), PublicOperationContractSchema).refine((operations) => Object.keys(operations).length > 0, "at least one operation is required"),
  limits: z.object({
    inputBytes: z.number().int().positive().max(262_144),
    outputBytes: z.number().int().positive().max(524_288),
    commandCount: z.number().int().positive().max(100),
    creatorIpcCount: z.number().int().positive().max(10_001),
    timeoutMs: z.number().int().positive().max(15_000),
  }).strict(),
}).strict();

export const PublicToolContractSchema = PublicToolBehaviorSchema.extend({
  contractHash: hash,
}).strict();

export const PublicToolManifestSchema = z.object({
  schemaVersion: z.literal(2),
  manifestHash: hash,
  tools: z.array(PublicToolContractSchema).length(43),
}).strict();

export type PublicToolBehavior = z.infer<typeof PublicToolBehaviorSchema>;
export type PublicToolContract = z.infer<typeof PublicToolContractSchema>;
export type PublicToolManifest = z.infer<typeof PublicToolManifestSchema>;

export function parseSignedProtectedRequest(value: unknown): SignedProtectedRequest {
  return SignedProtectedRequestSchema.parse(value);
}

export function parseSignedGatewayDecision(value: unknown): SignedGatewayDecision {
  return SignedGatewayDecisionSchema.parse(value);
}

export function parseProtectedRequest(value: unknown, nowMs = Date.now()): ProtectedRequest {
  const request = ProtectedRequestSchema.parse(value) as ProtectedRequest;
  if (Math.abs(nowMs - request.issuedAtMs) > CLOCK_SKEW_MAX_MS) throw new RangeError("request issuedAtMs outside clock-skew window");
  return request;
}

export function parseGatewayDecision(value: unknown): GatewayDecision {
  return GatewayDecisionSchema.parse(value) as GatewayDecision;
}
