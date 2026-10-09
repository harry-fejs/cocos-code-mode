import { KeyLike } from "node:crypto";
import { canonicalizeJson } from "./canonical-json";
import { ExecutionEnvelopeSchema } from "./primitive-contract";
import { verifyGatewayDecision, verifyProtectedRequest } from "./protocol";
import { ProtectedRequestSchema, SignedGatewayDecisionSchema, SignedProtectedRequestSchema } from "./schemas";

export type NegativeFixtureStage = "request-signature" | "decision-signature" | "request-schema" | "primitive-schema";
export interface NegativeFixture {
  id: string;
  stage: NegativeFixtureStage;
  path: Array<string | number>;
  operation: "set" | "delete" | "append";
  value?: unknown;
  expected: "reject-before-ipc";
}
export interface NegativeFixtureVectors {
  request: unknown;
  signedRequest: unknown;
  decisions: Record<string, { signed: unknown; decision: unknown }>;
}
export interface NegativeFixtureResult {
  id: string;
  rejectedAt: NegativeFixtureStage | "accepted";
  creatorMutationIpc: 0 | 1;
  error: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyMutation(root: unknown, fixture: NegativeFixture): unknown {
  const copy = clone(root);
  if (fixture.path.length === 0) return fixture.value;
  let parent: unknown = copy;
  for (const segment of fixture.path.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Reflect.has(parent, segment)) throw new Error(`invalid fixture path: ${fixture.id}`);
    parent = Reflect.get(parent, segment);
  }
  if (!parent || typeof parent !== "object") throw new Error(`invalid fixture parent: ${fixture.id}`);
  const leaf = fixture.path[fixture.path.length - 1];
  if (fixture.operation === "delete") Reflect.deleteProperty(parent, leaf);
  else if (fixture.operation === "append") {
    const target = Reflect.get(parent, leaf);
    if (!Array.isArray(target)) throw new Error(`fixture append target is not an array: ${fixture.id}`);
    target.push(clone(fixture.value));
  } else Reflect.set(parent, leaf, clone(fixture.value));
  return copy;
}

function mutateSignedPayload(wrapper: unknown, fixture: NegativeFixture): unknown {
  const parsed = SignedProtectedRequestSchema.or(SignedGatewayDecisionSchema).parse(wrapper);
  const payload = JSON.parse(Buffer.from(parsed.payload, "base64url").toString("utf8"));
  const mutated = applyMutation(payload, fixture);
  return { ...parsed, payload: Buffer.from(canonicalizeJson(mutated)).toString("base64url") };
}

export function runNegativeFixture(
  fixture: NegativeFixture,
  vectors: NegativeFixtureVectors,
  deviceKey: KeyLike,
  executionKey: KeyLike,
): NegativeFixtureResult {
  try {
    if (fixture.stage === "request-signature") {
      verifyProtectedRequest(SignedProtectedRequestSchema.parse(mutateSignedPayload(vectors.signedRequest, fixture)), deviceKey);
    } else if (fixture.stage === "decision-signature") {
      verifyGatewayDecision(SignedGatewayDecisionSchema.parse(mutateSignedPayload(vectors.decisions.mutation.signed, fixture)), executionKey);
    } else if (fixture.stage === "request-schema") {
      ProtectedRequestSchema.parse(applyMutation(vectors.request, fixture));
    } else {
      const decision = vectors.decisions.mutation.decision;
      if (!decision || typeof decision !== "object" || !("envelope" in decision)) throw new Error("mutation decision has no envelope");
      ExecutionEnvelopeSchema.parse(applyMutation(decision.envelope, fixture));
    }
  } catch (error) {
    return { id: fixture.id, rejectedAt: fixture.stage, creatorMutationIpc: 0, error: error instanceof Error ? error.message : String(error) };
  }
  return { id: fixture.id, rejectedAt: "accepted", creatorMutationIpc: 1, error: "" };
}
