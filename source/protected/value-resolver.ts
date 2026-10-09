import { CcpError } from "./errors";
import { assertIJson, canonicalizeToBytes, type IJson } from "./canonical-json";
import type { ExecutionEnvelope, PrimitiveCommand } from "./primitive-contract";
import type { ProtectedRequest } from "./protocol";

export type HandleKind = "node" | "component" | "asset";

export interface ConcreteHandle {
  id: string;
  type: string;
  kind: HandleKind;
}

export type HandleTable = Map<string, ConcreteHandle>;

function resolvePointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Value pointer is not a JSON pointer.");
  let current = root;
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encoded)) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Value pointer contains an invalid escape.");
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Value pointer does not select an array element.");
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Value pointer is outside the selected array.");
      current = current[index];
    } else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Value pointer does not exist.", { pointer });
    }
  }
  return current;
}

function resolveConstant(constants: IJson, id: string): unknown {
  let current: unknown = constants;
  for (const segment of id.split(".")) {
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/.test(segment)) {
      const index = Number(segment);
      if (index >= current.length) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Public constant index is outside its array.", { id });
      current = current[index];
    } else if (current && typeof current === "object" && !Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Public constant is not declared by this tool contract.", { id });
    }
  }
  return current;
}

function expectedHandleKind(command: PrimitiveCommand, path: readonly (string | number)[]): HandleKind | undefined {
  const leaf = String(path[path.length - 1] ?? "");
  if (command.op.startsWith("asset.") || command.op === "material.query") return "asset";
  if (command.op === "scene.addComponent" || command.op === "runtime.simulateButtonClick") return "node";
  if (command.op === "scene.removeComponent") return "component";
  if (command.op === "scene.createNode" || command.op === "scene.createPrimitive") {
    if (leaf === "asset") return "asset";
    return "node";
  }
  if (command.op === "scene.operateNode") return leaf === "prefabAsset" ? "asset" : "node";
  if (command.op === "scene.clipboard" || command.op === "scene.lifecycle") return "node";
  if (command.op === "scene.readNode" || command.op === "scene.readComponent") return "node";
  return undefined;
}

interface ResolveContext {
  request: ProtectedRequest;
  publicConstants: IJson;
  handles?: ReadonlyMap<string, ConcreteHandle>;
  command?: PrimitiveCommand;
}

function resolveValue(value: unknown, context: ResolveContext, path: readonly (string | number)[] = []): unknown {
  if (!value || typeof value !== "object") return value;
  if (!Array.isArray(value) && "source" in value) {
    if (value.source === "request" && "jsonPointer" in value && typeof value.jsonPointer === "string") {
      return resolvePointer(context.request, value.jsonPointer);
    }
    if (value.source === "observation" && "jsonPointer" in value && typeof value.jsonPointer === "string") {
      if (!context.request.observation) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Observation value was referenced without an observation.");
      return resolvePointer(context.request.observation, value.jsonPointer);
    }
    if (value.source === "public-contract-constant" && "id" in value && typeof value.id === "string") {
      return resolveConstant(context.publicConstants, value.id);
    }
    if (value.source === "handle" && "handle" in value && typeof value.handle === "string") {
      const concrete = context.handles?.get(value.handle);
      if (!concrete) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Command handle has no concrete Creator result.", { handle: value.handle });
      if (context.command) {
        const expected = expectedHandleKind(context.command, path);
        if (expected && concrete.kind !== expected) {
          throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Command handle has the wrong Creator entity type.", { handle: value.handle, expected, actual: concrete.kind });
        }
      }
      return concrete.id;
    }
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Unknown or malformed value provenance reference.");
  }
  if (Array.isArray(value)) return value.map((item, index) => resolveValue(item, context, [...path, index]));
  const resolved: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(resolved, key, { value: resolveValue(child, context, [...path, key]), enumerable: true, configurable: true, writable: true });
  }
  return resolved;
}

export function resolveProvenanceValue(
  value: unknown,
  request: ProtectedRequest,
  publicConstants: IJson = {},
  handles?: ReadonlyMap<string, ConcreteHandle>,
): unknown {
  return resolveValue(value, { request, publicConstants, handles });
}

export function resolveCommand(command: PrimitiveCommand, request: ProtectedRequest, publicConstants: IJson, handles: ReadonlyMap<string, ConcreteHandle>): PrimitiveCommand {
  return { ...command, args: resolveValue(command.args, { request, publicConstants, handles, command }, ["args"]) } as PrimitiveCommand;
}

function visitReferences(value: unknown, found: unknown[], request: ProtectedRequest, publicConstants: IJson): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value) && "source" in value) {
    if (value.source === "request" && "jsonPointer" in value && typeof value.jsonPointer === "string") {
      found.push(resolvePointer(request, value.jsonPointer));
      return;
    }
    if (value.source === "observation" && "jsonPointer" in value && typeof value.jsonPointer === "string") {
      if (!request.observation) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Observation value was referenced without an observation.");
      resolvePointer(request.observation, value.jsonPointer);
      return;
    }
    if (value.source === "public-contract-constant" && "id" in value && typeof value.id === "string") {
      resolveConstant(publicConstants, value.id);
      return;
    }
    if (value.source === "handle") return;
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Unknown or malformed value provenance reference.");
  }
  for (const child of Object.values(value)) visitReferences(child, found, request, publicConstants);
}

export function preflightReferencedInputBytes(envelope: ExecutionEnvelope, request: ProtectedRequest, publicConstants: IJson): number {
  const referenced: unknown[] = [];
  for (const command of envelope.commands) visitReferences(command.args, referenced, request, publicConstants);
  let bytes = 0;
  for (const value of referenced) {
    assertIJson(value);
    bytes += canonicalizeToBytes(value).byteLength;
  }
  if (bytes > envelope.limits.inputBytes) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", "Canonical referenced input exceeds the signed envelope limit.", { actualBytes: bytes, maxBytes: envelope.limits.inputBytes });
  }
  return bytes;
}

function kindCreatedBy(command: PrimitiveCommand): HandleKind {
  if (command.op === "scene.createNode" || command.op === "scene.createPrimitive" || (command.op === "scene.operateNode" && command.args.action === "copy")) return "node";
  if (command.op === "scene.addComponent") return "component";
  if (command.op === "asset.operate" && command.args.action === "copy") return "asset";
  throw new CcpError("CCP_CONTRACT_MISMATCH", "Primitive declared a handle without a finite handle result type.", { op: command.op });
}

function resultReference(result: unknown): { id: string; type: string } {
  let candidate = result;
  if (result && typeof result === "object") {
    if ("reference" in result) candidate = result.reference;
    else if ("copiedNodeReference" in result) candidate = result.copiedNodeReference;
  }
  if (typeof candidate === "string" && candidate) return { id: candidate, type: "unknown" };
  if (candidate && typeof candidate === "object" && "id" in candidate && typeof candidate.id === "string" && candidate.id) {
    const type = "type" in candidate && typeof candidate.type === "string" && candidate.type ? candidate.type : "unknown";
    return { id: candidate.id, type };
  }
  throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Creator did not return a concrete reference for the declared handle.");
}

export function registerCommandHandle(table: HandleTable, command: PrimitiveCommand, result: unknown): void {
  if (!command.createsHandle) return;
  if (table.has(command.createsHandle)) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Creator handle was produced more than once.", { handle: command.createsHandle });
  const reference = resultReference(result);
  table.set(command.createsHandle, { ...reference, kind: kindCreatedBy(command) });
}
