import { canonicalizeToBytes } from "./canonical-json.ts";
import { CcpError } from "./errors.ts";
import type { ProtectedRequest } from "./protocol.ts";
import { PUBLIC_TOOL_BY_NAME } from "./tool-catalog.ts";

type JsonSchema = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", message, { path });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaMatches(value: unknown, schema: JsonSchema): boolean {
  try {
    validateSchema(value, schema, "");
    return true;
  } catch {
    return false;
  }
}

function validateSchema(value: unknown, schema: JsonSchema, path: string): void {
  if (value === null && schema.nullable === true) return;
  const type = schema.type;
  const properties = isObject(schema.properties) ? schema.properties as Record<string, JsonSchema> : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (type === "object" || Object.keys(properties).length > 0 || required.length > 0) {
    if (!isObject(value)) fail(path, "Protected input must be an object.");
    if (type === "object") {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) fail(`${path}/${key}`, "Request contains an unapproved input field.");
      }
    }
    for (const key of required) {
      if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) {
        fail(`${path}/${key}`, "Request is missing a required input field.");
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateSchema(value[key], childSchema, `${path}/${key}`);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) fail(path, "Protected input must be an array.");
    if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(path, "Protected input array is too short.");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(path, "Protected input array is too long.");
    const itemSchema = isObject(schema.items) ? schema.items : {};
    value.forEach((child, index) => validateSchema(child, itemSchema, `${path}/${index}`));
  } else if (type === "string") {
    if (typeof value !== "string") fail(path, "Protected input must be a string.");
    if (typeof schema.minLength === "number" && value.length < schema.minLength) fail(path, "Protected input string is too short.");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) fail(path, "Protected input string is too long.");
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
      fail(path, `Protected input must be a finite ${type}.`);
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(path, "Protected input is below its minimum.");
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(path, "Protected input exceeds its maximum.");
  } else if (type === "boolean" && typeof value !== "boolean") {
    fail(path, "Protected input must be a boolean.");
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) fail(path, "Protected input is outside its finite enum.");
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !Object.is(schema.const, value)) fail(path, "Protected input does not match the required branch.");

  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      if (!isObject(child)) fail(path, "Canonical input schema is invalid.");
      validateSchema(value, child, path);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter((child) => isObject(child) && schemaMatches(value, child)).length;
    if (matches === 0) fail(path, "Protected input does not match any allowed branch.");
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((child) => isObject(child) && schemaMatches(value, child)).length;
    if (matches !== 1) fail(path, "Protected input must match exactly one allowed branch.");
  }
  if (isObject(schema.if) && schemaMatches(value, schema.if) && isObject(schema.then)) validateSchema(value, schema.then, path);
}

function validateCrossFieldRules(toolId: string, inputs: Record<string, unknown>): void {
  if (toolId === "inspectorSet" && Array.isArray(inputs.propertyPaths) && Array.isArray(inputs.values)
      && inputs.propertyPaths.length !== inputs.values.length) {
    fail("/propertyPaths", "Property paths and values must have equal lengths.");
  }
  if (toolId === "nodeBatchSet" && Array.isArray(inputs.entries)) {
    inputs.entries.forEach((entry, index) => {
      if (isObject(entry) && Array.isArray(entry.propertyPaths) && Array.isArray(entry.values)
          && entry.propertyPaths.length !== entry.values.length) {
        fail(`/entries/${index}/propertyPaths`, "Property paths and values must have equal lengths.");
      }
    });
  }
  if (toolId === "nodeReset" && inputs.operation === "property" && Array.isArray(inputs.references)
      && inputs.references.length !== 1) {
    fail("/references", "Property reset requires exactly one reference.");
  }
}

export function filterProtectedInputs(request: ProtectedRequest): ProtectedRequest {
  const contract = PUBLIC_TOOL_BY_NAME[request.tool.id];
  if (!contract || contract.contractVersion !== request.tool.contractVersion || contract.contractHash !== request.tool.contractHash) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Tool does not match the canonical executable contract.", { tool: request.tool.id });
  }
  if (!isObject(request.inputs)) fail("/inputs", "Protected inputs must be a bounded object.");
  validateSchema(request.inputs, contract.inputSchema, "/inputs");
  validateCrossFieldRules(request.tool.id, request.inputs);

  const totalBytes = canonicalizeToBytes(request.inputs).byteLength;
  if (totalBytes > contract.limits.inputBytes) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", "Protected inputs exceed the canonical byte limit.", { bytes: totalBytes });
  }
  for (const field of contract.inputFields) {
    const key = field.jsonPointer.slice(1);
    if (!Object.prototype.hasOwnProperty.call(request.inputs, key)) continue;
    const bytes = canonicalizeToBytes(request.inputs[key]).byteLength;
    if (field.gatewayTransfer !== "allowed" || bytes > field.maxBytes) {
      throw new CcpError("CCP_LIMIT_EXCEEDED", "Protected input field exceeds its transfer contract.", { field: key, bytes });
    }
  }
  return request;
}
