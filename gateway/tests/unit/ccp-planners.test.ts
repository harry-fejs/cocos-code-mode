import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertIJson } from "../../src/ccp/canonical-json.ts";
import { CcpError } from "../../src/ccp/errors.ts";
import type { ExecutionEnvelope } from "../../src/ccp/primitive-contract.ts";
import { filterProtectedInputs } from "../../src/ccp/input-filter.ts";
import { validateGatewayDecision } from "../../src/ccp/plan-validator.ts";
import { ProtectedToolRegistry, type PlannerContext } from "../../src/ccp/protected-tool-registry.ts";
import type { ProtectedRequest } from "../../src/ccp/protocol.ts";
import { registerCatalogPlanners } from "../../src/ccp/runtime.ts";
import { PUBLIC_TOOL_MANIFEST } from "../../src/ccp/tool-catalog.ts";

type Contract = (typeof PUBLIC_TOOL_MANIFEST.tools)[number];
type JsonSchema = Record<string, unknown>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function branchMatches(branch: JsonSchema, inputs: Record<string, unknown>): boolean {
  if (!object(branch.properties)) return true;
  for (const [field, fieldSchema] of Object.entries(branch.properties)) {
    if (object(fieldSchema) && "const" in fieldSchema && inputs[field] !== fieldSchema.const) return false;
  }
  return true;
}

function sample(schema: JsonSchema): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === "string") return "sample";
  if (schema.type === "number" || schema.type === "integer") return typeof schema.minimum === "number" ? schema.minimum : 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "array") return [sample(object(schema.items) ? schema.items : {})];
  if (schema.type === "object" || object(schema.properties)) {
    const value: Record<string, unknown> = {};
    fillRequired(value, schema);
    return value;
  }
  return "value";
}

function fillRequired(inputs: Record<string, unknown>, schema: JsonSchema): void {
  const properties = object(schema.properties) ? schema.properties as Record<string, JsonSchema> : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of required) if (typeof field === "string" && !(field in inputs)) inputs[field] = sample(properties[field] ?? {});
  if (Array.isArray(schema.allOf)) {
    for (const clause of schema.allOf) {
      if (!object(clause) || !object(clause.if) || !branchMatches(clause.if, inputs) || !object(clause.then)) continue;
      fillRequired(inputs, { ...clause.then, properties });
    }
  }
  for (const keyword of ["oneOf", "anyOf"] as const) {
    if (!Array.isArray(schema[keyword])) continue;
    const choices = schema[keyword].filter(object);
    const choice = choices.find((candidate) => branchMatches(candidate, inputs)) ?? choices[0];
    if (choice) fillRequired(inputs, { ...choice, properties });
  }
}

function inputsFor(contract: Contract, operation: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = operation === "*" ? {} : { operation };
  fillRequired(inputs, contract.inputSchema);
  if (contract.name === "createLabel") Object.assign(inputs, { text: "Hello", fontSize: 24, color: "#ffffff" });
  if (contract.name === "createButton") inputs.text = "Click";
  if (contract.name === "createSprite") inputs.spriteFrameUuid = "sprite-frame";
  if (contract.name === "projectManage" && operation === "set") inputs.value = { title: "Game" };
  return inputs;
}

function requestFor(contract: Contract, operation: string): ProtectedRequest {
  const inputs = inputsFor(contract, operation);
  assertIJson(inputs);
  const selected = contract.operations[operation];
  const observation = selected.observation.contractId === "none-v1" ? undefined : {
    contractId: selected.observation.contractId,
    consentVersion: selected.observation.consentVersion,
    revisionToken: "revision-1",
    digest: "a".repeat(64),
    fields: Object.fromEntries(selected.observation.fields.map((field) => [field, { id: `${field}-1` }])),
  };
  return {
    protocolVersion: 1,
    requestId: randomUUID(),
    idempotencyKey: "stable-idempotency-key",
    deviceId: randomUUID(),
    projectId: randomUUID(),
    relayInstanceId: randomUUID(),
    sequence: 1,
    issuedAtMs: 1_893_456_000_000,
    nonce: "abcdefghijklmnopqrstuv",
    tool: { id: contract.name, contractVersion: contract.contractVersion, contractHash: contract.contractHash },
    relay: { build: contract.minimumRelayBuild, packageHash: "b".repeat(64), creatorVersion: "3.8.0", os: "win32" },
    inputs,
    observation,
  };
}

function contextFor(contract: Contract, operation: string): PlannerContext {
  return {
    request: requestFor(contract, operation),
    policy: {
      toolId: contract.name,
      contractVersion: contract.contractVersion,
      enabled: true,
      contractHash: contract.contractHash,
      minimumRelayBuild: contract.minimumRelayBuild,
      blockedRelayBuilds: [],
      creatorRange: contract.creatorRange,
      requiredConsentVersion: contract.operations[operation].observation.consentVersion,
      revision: 1,
    },
    correlationId: randomUUID(),
    nowMs: 1_893_456_000_000,
  };
}

function plan(registry: ProtectedToolRegistry, contract: Contract, operation: string) {
  const context = contextFor(contract, operation);
  filterProtectedInputs(context.request);
  const decision = validateGatewayDecision(registry.plan(context), context.request);
  if (decision.kind !== "execute") throw new Error("expected execute decision");
  return { context, envelope: decision.envelope };
}
function ccpCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CcpError) return error.body.code;
    throw error;
  }
  throw new Error("expected CCP denial");
}


describe("CCP finite planners", () => {
  const registry = new ProtectedToolRegistry();
  registerCatalogPlanners(registry);

  it("plans every canonical tool and every operation branch with its finite semantics", () => {
    let branchCount = 0;
    for (const contract of PUBLIC_TOOL_MANIFEST.tools) {
      for (const [operationName, operation] of Object.entries(contract.operations)) {
        let envelope: ExecutionEnvelope;
        try {
          envelope = plan(registry, contract, operationName).envelope;
        } catch (error) {
          throw new Error(`${contract.name}.${operationName}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        branchCount += 1;
        expect(envelope.effect, `${contract.name}.${operationName} effect`).toBe(operation.effect);
        expect(envelope.return.mode, `${contract.name}.${operationName} result`).toBe(operation.resultMode);
        expect([...new Set(envelope.commands.map((command) => command.op))], `${contract.name}.${operationName} primitives`).toEqual(operation.primitives);
        expect(envelope.limits.commandCount, `${contract.name}.${operationName} commands`).toBe(envelope.commands.length);
        expect(envelope.limits.ipcCount).toBeLessThanOrEqual(contract.limits.creatorIpcCount);
        expect(envelope.limits.timeoutMs).toBe(contract.limits.timeoutMs);
        if (operation.effect === "none") {
          expect(envelope.preconditions).toEqual([]);
          expect(envelope.transaction).toMatchObject({ mode: "read", snapshot: "none" });
        } else {
          expect(envelope.preconditions).toHaveLength(1);
          expect(envelope.transaction.mode).toBe("ordered-effect");
        }
      }
    }
    expect(branchCount).toBeGreaterThan(47);
  });

  it("uses operation-specific request provenance and handle flow", () => {
    const createLabel = PUBLIC_TOOL_MANIFEST.tools.find((contract) => contract.name === "createLabel")!;
    const label = plan(registry, createLabel, "*").envelope;
    expect(label.commands.map((command) => command.op)).toEqual(["scene.createNode", "scene.setProperties"]);
    expect(label.commands[1]).toMatchObject({
      usesHandles: ["label-node"],
      args: {
        target: { source: "handle", handle: "label-node" },
        values: [
          { property: { source: "public-contract-constant", id: "propertyPaths.0" }, value: { source: "request", jsonPointer: "/inputs/text" } },
          { property: { source: "public-contract-constant", id: "propertyPaths.1" }, value: { source: "request", jsonPointer: "/inputs/fontSize" } },
          { property: { source: "public-contract-constant", id: "propertyPaths.2" }, value: { source: "request", jsonPointer: "/inputs/color" } },
        ],
      },
    });

    const assets = PUBLIC_TOOL_MANIFEST.tools.find((contract) => contract.name === "assetGetAtPath")!;
    expect(plan(registry, assets, "*").envelope.commands[0]).toMatchObject({
      op: "asset.query",
      args: { action: "at-path", assetPath: { source: "request", jsonPointer: "/inputs/assetPath" } },
    });
    const runtime = PUBLIC_TOOL_MANIFEST.tools.find((contract) => contract.name === "runtimeSetTimeScale")!;
    expect(plan(registry, runtime, "*").envelope.commands[0]).toMatchObject({
      op: "runtime.control", args: { action: "set-time-scale", value: { source: "request", jsonPointer: "/inputs/scale" } },
    });
  });

  it("rejects unknown, invalid conditional, and mismatched observation inputs", () => {
    const contract = PUBLIC_TOOL_MANIFEST.tools.find((entry) => entry.name === "nodeOperate")!;
    const missingDestination = requestFor(contract, "move");
    delete (missingDestination.inputs as Record<string, unknown>).newParentReference;
    expect(ccpCode(() => filterProtectedInputs(missingDestination))).toBe("CCP_VALUE_PROVENANCE_INVALID");

    const unknown = requestFor(contract, "delete");
    (unknown.inputs as Record<string, unknown>).rawMessage = "forbidden";
    expect(ccpCode(() => filterProtectedInputs(unknown))).toBe("CCP_VALUE_PROVENANCE_INVALID");

    const wrongObservation = contextFor(contract, "delete");
    wrongObservation.request.observation!.contractId = "editor-state-v1";
    expect(ccpCode(() => registry.plan(wrongObservation))).toBe("CCP_VALUE_PROVENANCE_INVALID");
  });

  it("rejects tampered effect, handle, result, count, and referenced-input byte limits", () => {
    const contract = PUBLIC_TOOL_MANIFEST.tools.find((entry) => entry.name === "inspectorSet")!;
    const planned = plan(registry, contract, "*");
    const decision = registry.plan(planned.context);
    if (decision.kind !== "execute") throw new Error("expected execute decision");

    expect(ccpCode(() => validateGatewayDecision(
      { ...decision, envelope: { ...decision.envelope, effect: "none" } },
      planned.context.request,
    ))).toBe("CCP_PRIMITIVE_UNKNOWN");
    const invalidHandle = structuredClone(decision);
    if (invalidHandle.kind !== "execute") throw new Error("expected execute decision");
    invalidHandle.envelope.commands[0].usesHandles = ["missing"];
    expect(ccpCode(() => validateGatewayDecision(invalidHandle, planned.context.request))).toBe("CCP_PRIMITIVE_UNKNOWN");
    expect(ccpCode(() => validateGatewayDecision({
      ...decision,
      envelope: { ...decision.envelope, return: { mode: "execution-summary" }, limits: { ...decision.envelope.limits, commandCount: 99 } },
    }, planned.context.request))).toBe("CCP_PRIMITIVE_UNKNOWN");

    const project = PUBLIC_TOOL_MANIFEST.tools.find((entry) => entry.name === "projectManage")!;
    const oversized = contextFor(project, "set");
    const oversizedDecision = registry.plan(oversized);
    (oversized.request.inputs as Record<string, unknown>).value = "x".repeat(project.limits.inputBytes);
    expect(ccpCode(() => validateGatewayDecision(oversizedDecision, oversized.request))).toBe("CCP_LIMIT_EXCEEDED");
  });
});
