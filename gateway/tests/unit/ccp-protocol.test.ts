import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalizeJson, parseCanonicalJson } from "../../src/ccp/canonical-json";
import { PrimitiveCommandSchema, ExecutionEnvelopeSchema } from "../../src/ccp/primitive-contract";
import { runNegativeFixture } from "../../src/ccp/negative-fixture-runner";
import type { NegativeFixture } from "../../src/ccp/negative-fixture-runner";
import { verifyGatewayDecision, verifyProtectedRequest } from "../../src/ccp/protocol";
import { GatewayDecisionSchema, ProtectedRequestSchema, SignedGatewayDecisionSchema, SignedProtectedRequestSchema } from "../../src/ccp/schemas";

const fixtureRoot = join(import.meta.dirname, "..", "fixtures", "ccp", "v1");
const keys = JSON.parse(readFileSync(join(fixtureRoot, "test-keys.json"), "utf8"));
const vectorFixture = z.object({ signed: SignedGatewayDecisionSchema, decision: GatewayDecisionSchema });
const vectors = z.object({ request: ProtectedRequestSchema, signedRequest: SignedProtectedRequestSchema, decisions: z.record(vectorFixture) }).parse(JSON.parse(readFileSync(join(fixtureRoot, "vectors.json"), "utf8")));
const canonicalCases = JSON.parse(readFileSync(join(fixtureRoot, "canonical-cases.json"), "utf8"));
const negativeCases = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(z.object({
    id: z.string(),
    stage: z.enum(["request-signature", "decision-signature", "request-schema", "primitive-schema"]),
    path: z.array(z.union([z.string(), z.number().int()])),
    operation: z.enum(["set", "delete", "append"]),
    value: z.unknown().optional(),
    expected: z.literal("reject-before-ipc"),
  })),
}).parse(JSON.parse(readFileSync(join(fixtureRoot, "negative-cases.json"), "utf8")));
const devicePublicKey = createPublicKey({ key: Buffer.from(keys.device.publicKeySpki, "base64url"), format: "der", type: "spki" });
const executionPublicKey = createPublicKey({ key: Buffer.from(keys.execution.publicKeySpki, "base64url"), format: "der", type: "spki" });

describe("CCP v1 byte contract", () => {
  it("verifies cross-repository request and all decision fixtures", () => {
    expect(ProtectedRequestSchema.parse(verifyProtectedRequest(vectors.signedRequest, devicePublicKey))).toEqual(vectors.request);
    for (const fixture of Object.values(vectors.decisions)) {
      expect(GatewayDecisionSchema.parse(verifyGatewayDecision(fixture.signed, executionPublicKey))).toEqual(fixture.decision);
    }
  });

  it("rejects signature tampering before payload use", () => {
    const tampered = { ...vectors.signedRequest, signature: `${vectors.signedRequest.signature.slice(0, -1)}A` };
    expect(() => verifyProtectedRequest(tampered, devicePublicKey)).toThrow("invalid device signature");
  });

  it("rejects every non-canonical source fixture", () => {
    for (const source of canonicalCases.invalidSources) {
      expect(() => parseCanonicalJson(Buffer.from(source), 1024)).toThrow();
    }
    expect(canonicalizeJson(canonicalCases.rfc8785.input)).toBe(canonicalCases.rfc8785.canonical);
  });

  it("rejects unknown fields and arbitrary primitive values", () => {
    expect(() => ProtectedRequestSchema.parse({ ...vectors.request, unexpected: true })).toThrow();
    expect(() => PrimitiveCommandSchema.parse({ op: "asset.writeText", commandId: "write", args: { content: "source" } })).toThrow();
    expect(() => PrimitiveCommandSchema.parse({ op: "scene.setProperties", commandId: "set", args: { target: { source: "handle", handle: "n" }, values: [{ property: { source: "public-contract-constant", id: "text" }, value: "Gateway-authored" }] } })).toThrow();
  });

  it("requires ordered transactions and preconditions for every effect", () => {
    const decision = vectors.decisions.mutation.decision;
    if (decision.kind !== "execute") throw new Error("mutation fixture must contain an execution envelope");
    const envelope = decision.envelope;
    expect(ExecutionEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() => ExecutionEnvelopeSchema.parse({ ...envelope, preconditions: [] })).toThrow("effect requires preconditions");
    expect(() => ExecutionEnvelopeSchema.parse({ ...envelope, transaction: { ...envelope.transaction, mode: "read" } })).toThrow("effect requires ordered transaction");
  });

  it("executes every fail-closed fixture before simulated Creator mutation IPC", () => {
    const ids = negativeCases.cases.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(50);
    const results = negativeCases.cases.map((fixture) => runNegativeFixture(fixture as NegativeFixture, vectors, devicePublicKey, executionPublicKey));
    expect(results.filter((result) => result.rejectedAt === "accepted")).toEqual([]);
    expect(results.every((result) => result.creatorMutationIpc === 0)).toBe(true);
  });
});
