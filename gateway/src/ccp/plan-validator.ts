import { canonicalizeToBytes } from "./canonical-json.ts";
import { CcpError } from "./errors.ts";
import { primitiveCommandSemantics, type Effect } from "./primitive-contract.ts";
import type { GatewayDecision, ProtectedRequest } from "./protocol.ts";
import { GatewayDecisionSchema } from "./schemas.ts";
import { PUBLIC_TOOL_BY_NAME } from "./tool-catalog.ts";

function resolvePointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Value reference is not a JSON pointer.");
  let current = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/.test(segment)) current = current[Number(segment)];
    else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) current = current[segment as keyof typeof current];
    else throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Planner referenced a missing value.", { pointer });
  }
  return current;
}

function contractConstant(root: unknown, id: string): unknown {
  return resolvePointer(root, `/${id.split(".").join("/")}`);
}

function operationName(request: ProtectedRequest): string {
  if (request.inputs && typeof request.inputs === "object" && !Array.isArray(request.inputs)
      && "operation" in request.inputs && typeof request.inputs.operation === "string") return request.inputs.operation;
  const contract = PUBLIC_TOOL_BY_NAME[request.tool.id];
  const properties = contract?.inputSchema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties) && "operation" in properties) {
    const schema = properties.operation;
    if (schema && typeof schema === "object" && !Array.isArray(schema) && "default" in schema && typeof schema.default === "string") return schema.default;
  }
  return "*";
}

interface ProvenanceAudit {
  inputBytes: number;
  handles: Set<string>;
}

function auditProvenance(value: unknown, request: ProtectedRequest, constants: unknown, audit: ProvenanceAudit): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value) && "source" in value) {
    if (value.source === "request" && "jsonPointer" in value && typeof value.jsonPointer === "string") {
      audit.inputBytes += canonicalizeToBytes(resolvePointer(request, value.jsonPointer)).byteLength;
      return;
    }
    if (value.source === "observation" && "jsonPointer" in value && typeof value.jsonPointer === "string") {
      if (!request.observation) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Planner referenced an absent observation.");
      canonicalizeToBytes(resolvePointer(request.observation, value.jsonPointer));
      return;
    }
    if (value.source === "public-contract-constant" && "id" in value && typeof value.id === "string") {
      canonicalizeToBytes(contractConstant(constants, value.id));
      return;
    }
    if (value.source === "handle" && "handle" in value && typeof value.handle === "string") {
      audit.handles.add(value.handle);
      return;
    }
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Planner emitted an unapproved value source.");
  }
  for (const child of Object.values(value)) auditProvenance(child, request, constants, audit);
}

const effectRank: Record<Effect, number> = { none: 0, "local-state": 1, "project-write": 2, "external-side-effect": 3 };

export function validateGatewayDecision(decision: unknown, request: ProtectedRequest): GatewayDecision {
  let parsed: GatewayDecision;
  try {
    parsed = GatewayDecisionSchema.parse(decision);
  } catch {
    throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Planner output failed the closed decision schema.");
  }
  const binding = parsed.binding;
  if (
    binding.requestId !== request.requestId || binding.deviceId !== request.deviceId || binding.projectId !== request.projectId
    || binding.relayInstanceId !== request.relayInstanceId || binding.nonce !== request.nonce || binding.sequence !== request.sequence
    || binding.tool.id !== request.tool.id || binding.tool.contractVersion !== request.tool.contractVersion
    || binding.tool.contractHash !== request.tool.contractHash || binding.relay.build !== request.relay.build
    || binding.relay.packageHash !== request.relay.packageHash
  ) throw new CcpError("CCP_CONTRACT_MISMATCH", "Decision binding does not match the admitted request.");
  const contract = PUBLIC_TOOL_BY_NAME[request.tool.id];
  if (!contract || contract.contractVersion !== request.tool.contractVersion || contract.contractHash !== request.tool.contractHash) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Decision is not bound to the canonical tool contract.");
  }
  if (binding.creatorRange !== contract.creatorRange || binding.expiresAtMs - binding.issuedAtMs > contract.limits.timeoutMs) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Decision binding exceeds the canonical contract.");
  }
  if (parsed.kind !== "execute") {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Protected tools must return relay-local primitive results.");
  }

  const operation = contract.operations[operationName(request)];
  if (!operation) throw new CcpError("CCP_CONTRACT_MISMATCH", "Decision operation is outside the canonical contract.");
  const envelope = parsed.envelope;
  const primitiveIds = envelope.commands.map((command) => command.op);
  if (primitiveIds.some((primitive) => !operation.primitives.includes(primitive))) {
    throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Decision uses a primitive outside the selected operation contract.");
  }

  const expectedReturn = operation.resultMode;
  if (envelope.return.mode !== expectedReturn) throw new CcpError("CCP_CONTRACT_MISMATCH", "Decision result selector does not match the selected operation.");
  const commandIds = new Set(envelope.commands.map((command) => command.commandId));
  if (envelope.return.mode === "command-result" && !commandIds.has(envelope.return.commandId)) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Decision result command does not exist.");
  }
  if (envelope.return.mode === "command-results"
      && (new Set(envelope.return.commandIds).size !== envelope.return.commandIds.length
        || envelope.return.commandIds.some((id) => !commandIds.has(id)))) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Decision result commands do not exist or are duplicated.");
  }

  const createdHandles = new Set<string>();
  let requiredRank = 0;
  let requiredIpc = envelope.transaction.snapshot === "none" ? 0 : 1;
  let inputBytes = 0;
  for (const command of envelope.commands) {
    const audit: ProvenanceAudit = { inputBytes: 0, handles: new Set() };
    auditProvenance(command.args, request, contract.publicConstants, audit);
    inputBytes += audit.inputBytes;
    const declared = [...command.usesHandles].sort();
    const actual = [...audit.handles].sort();
    if (new Set(declared).size !== declared.length || declared.join("\0") !== actual.join("\0")) {
      throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Decision handle declarations do not match their references.");
    }
    for (const handle of actual) if (!createdHandles.has(handle)) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Decision references a handle before creation.");
    const semantics = primitiveCommandSemantics(command);
    requiredRank = Math.max(requiredRank, effectRank[semantics.effect]);
    requiredIpc += semantics.ipcCount;
    if (semantics.createsHandle !== Boolean(command.createsHandle)) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Decision handle creation does not match primitive semantics.");
    if (command.createsHandle) {
      if (createdHandles.has(command.createsHandle)) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Decision creates a duplicate handle.");
      createdHandles.add(command.createsHandle);
    }
  }
  const effect = (["none", "local-state", "project-write", "external-side-effect"] as const)[requiredRank];
  if (envelope.effect !== effect || envelope.effect !== operation.effect) throw new CcpError("CCP_CONTRACT_MISMATCH", "Decision effect does not match command semantics.");
  if (envelope.limits.commandCount !== envelope.commands.length || envelope.limits.ipcCount !== requiredIpc) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", "Decision command or IPC counts are incorrect.");
  }
  if (envelope.commands.length > contract.limits.commandCount || requiredIpc > contract.limits.creatorIpcCount
      || envelope.limits.outputBytes > contract.limits.outputBytes || envelope.limits.timeoutMs > contract.limits.timeoutMs) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", "Decision exceeds its signed operation limits.");
  }
  if (envelope.limits.inputBytes !== inputBytes || inputBytes > contract.limits.inputBytes) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", "Decision referenced-input byte count is incorrect or oversized.", { bytes: inputBytes });
  }
  return parsed;
}
