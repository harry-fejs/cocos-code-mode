import { canonicalizeToBytes } from "../canonical-json.ts";
import { CcpError } from "../errors.ts";
import { primitiveCommandSemantics, type Effect, type ExecutionEnvelope, type PrimitiveCommand } from "../primitive-contract.ts";
import type { PlannerContext } from "../protected-tool-registry.ts";
import type { GatewayDecision } from "../protocol.ts";
import { PUBLIC_TOOL_BY_NAME } from "../tool-catalog.ts";

export const requestValue = (field: string) => ({ source: "request" as const, jsonPointer: `/inputs/${field}` });
export const requestPointer = (jsonPointer: string) => ({ source: "request" as const, jsonPointer });
export const observationValue = (field: string) => ({ source: "observation" as const, jsonPointer: `/fields/${field}` });
export const contractConstant = (id: string) => ({ source: "public-contract-constant" as const, id });
export const handleValue = (handle: string) => ({ source: "handle" as const, handle });

export function inputObject(context: PlannerContext): Record<string, unknown> {
  const inputs = context.request.inputs;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Protected inputs must be an object.");
  }
  return inputs;
}

export function operationName(context: PlannerContext): string {
  const inputs = inputObject(context);
  if (typeof inputs.operation === "string") return inputs.operation;
  const contract = PUBLIC_TOOL_BY_NAME[context.request.tool.id];
  const properties = contract?.inputSchema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties) && "operation" in properties) {
    const operationSchema = properties.operation;
    if (operationSchema && typeof operationSchema === "object" && !Array.isArray(operationSchema)
        && "default" in operationSchema && typeof operationSchema.default === "string") {
      return operationSchema.default;
    }
  }
  return "*";
}

export function finiteString<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.some((candidate) => candidate === value)) {
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", `${label} is outside its finite contract.`);
  }
  return value as T[number];
}

function resolvePointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/.test(segment)) current = current[Number(segment)];
    else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) current = current[segment as keyof typeof current];
    else throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Planner referenced a missing request value.", { pointer });
  }
  return current;
}

export function referencedRequestBytes(value: unknown, request: PlannerContext["request"]): number {
  if (!value || typeof value !== "object") return 0;
  if (!Array.isArray(value) && "source" in value && value.source === "request") {
    const pointer = "jsonPointer" in value ? value.jsonPointer : undefined;
    if (typeof pointer !== "string" || !pointer.startsWith("/")) {
      throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Planner emitted an invalid request pointer.");
    }
    return canonicalizeToBytes(resolvePointer(request, pointer)).byteLength;
  }
  return Object.values(value).reduce((total, child) => total + referencedRequestBytes(child, request), 0);
}

function preconditionKind(contractId: string): "observation" | "entity" | "lifecycle" | "build-task" {
  if (contractId === "scene-target-v1" || contractId === "animation-target-v1") return "entity";
  if (contractId === "build-task-v1") return "build-task";
  if (["scene-lifecycle-v1", "runtime-state-v1", "editor-state-v1", "editor-history-v1", "project-setting-v1"].includes(contractId)) return "lifecycle";
  return "observation";
}

function assertObservation(context: PlannerContext, contractId: string, consentVersion: string, fields: readonly string[]): void {
  const observation = context.request.observation;
  if (contractId === "none-v1") {
    if (observation !== undefined) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Read operation must not send an observation.");
    return;
  }
  if (!observation || observation.contractId !== contractId || observation.consentVersion !== consentVersion) {
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Request observation does not match the selected operation.");
  }
  if (!observation.fields || typeof observation.fields !== "object" || Array.isArray(observation.fields)) {
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Request observation fields are invalid.");
  }
  const actual = Object.keys(observation.fields).sort();
  const expected = [...fields].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Request observation fields do not match the selected operation.");
  }
}

export function planCommands(
  context: PlannerContext,
  commands: PrimitiveCommand[],
  resultCommandIds?: string[],
): GatewayDecision {
  const contract = PUBLIC_TOOL_BY_NAME[context.request.tool.id];
  if (!contract || contract.contractVersion !== context.request.tool.contractVersion || contract.contractHash !== context.request.tool.contractHash) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Planner request does not match the canonical tool contract.");
  }
  const operation = contract.operations[operationName(context)];
  if (!operation) throw new CcpError("CCP_CONTRACT_MISMATCH", "Planner has no finite branch for the requested operation.");
  assertObservation(context, operation.observation.contractId, operation.observation.consentVersion, operation.observation.fields);

  // Optional arguments are absent on the wire, never explicit undefined.
  for (const command of commands) {
    for (const key of Object.keys(command.args)) {
      if (Reflect.get(command.args, key) === undefined) Reflect.deleteProperty(command.args, key);
    }
  }

  const snapshot = operation.effect === "project-write" ? "once-after-success" : "none";
  const ipcCount = commands.reduce((total, command) => total + primitiveCommandSemantics(command).ipcCount, snapshot === "none" ? 0 : 1);
  const inputBytes = referencedRequestBytes(commands, context.request);
  if (commands.length > contract.limits.commandCount || ipcCount > contract.limits.creatorIpcCount
      || inputBytes > contract.limits.inputBytes) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", "Planned operation exceeds its canonical limits.", {
      commandCount: commands.length,
      ipcCount,
      inputBytes,
    });
  }
  const commandIds = resultCommandIds ?? [commands[0].commandId];
  let result: ExecutionEnvelope["return"];
  if (operation.resultMode === "execution-summary") result = { mode: "execution-summary" };
  else if (operation.resultMode === "command-results") result = { mode: "command-results", commandIds };
  else result = { mode: "command-result", commandId: commandIds[0] };

  const preconditions: ExecutionEnvelope["preconditions"] = operation.effect === "none" ? [] : [{
    kind: preconditionKind(operation.observation.contractId),
    revisionToken: context.request.observation!.revisionToken,
    digest: context.request.observation!.digest,
  }];
  return {
    kind: "execute",
    correlationId: context.correlationId,
    binding: {
      requestId: context.request.requestId,
      deviceId: context.request.deviceId,
      projectId: context.request.projectId,
      relayInstanceId: context.request.relayInstanceId,
      nonce: context.request.nonce,
      sequence: context.request.sequence,
      tool: context.request.tool,
      relay: { build: context.request.relay.build, packageHash: context.request.relay.packageHash },
      creatorRange: context.policy.creatorRange,
      issuedAtMs: context.nowMs,
      expiresAtMs: context.nowMs + contract.limits.timeoutMs,
    },
    envelope: {
      effect: operation.effect as Effect,
      commands,
      preconditions,
      transaction: { mode: operation.effect === "none" ? "read" : "ordered-effect", onError: "stop", snapshot },
      return: result,
      limits: {
        commandCount: commands.length,
        ipcCount,
        inputBytes,
        outputBytes: contract.limits.outputBytes,
        timeoutMs: contract.limits.timeoutMs,
      },
    },
  };
}
