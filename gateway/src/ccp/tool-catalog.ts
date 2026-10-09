import { createHash } from "node:crypto";
import manifestJson from "./public-tool-manifest.json";
import { canonicalizeToBytes } from "./canonical-json.ts";
import {
  PublicToolBehaviorSchema,
  PublicToolManifestSchema,
  type PublicToolBehavior,
  type PublicToolContract,
  type PublicToolManifest,
} from "./schemas.ts";
import type { OperationClass } from "./store.ts";

export const READ_TOOLS = [
  "sceneGetInfo", "nodeGetTree", "nodeGetAtPath", "assetGetTree", "assetGetAtPath", "assetResolvePath",
  "assetQuery", "assetGetAvailableUrl", "nodeGetAvailableComponentTypes", "nodeComponentsGet",
  "findNodesByAsset", "findNodesWithMissingAssets", "findNodes", "animationQuery", "materialQuery",
  "editorQuery", "assetBatchQuery", "getPerformanceSnapshot",
] as const;

export const MUTATION_TOOLS = ["createUiNode", "nodeCreate", "createLabel", "createButton", "createSprite", "nodeCreatePrimitive"] as const;
export const PROPERTY_TOOLS = ["nodeOperate", "nodeReset", "inspectorSet", "nodeBatchSet", "nodeComponentManage", "projectManage", "animationEdit", "propertyArrayElement", "nodeClipboard", "sceneManage"] as const;
export const CONTROL_TOOLS = ["runtimePause", "runtimeResume", "runtimeSetTimeScale", "runtimeGetState", "editorHistory", "editorSelect", "editorViewport", "buildManage", "simulateButtonClick"] as const;
export const ALL_PUBLIC_TOOLS = [...READ_TOOLS, ...MUTATION_TOOLS, ...PROPERTY_TOOLS, ...CONTROL_TOOLS] as const;

export const TOOL_CLASS: Record<string, OperationClass> = {
  ...Object.fromEntries(READ_TOOLS.map((id) => [id, "read"])),
  ...Object.fromEntries(MUTATION_TOOLS.map((id) => [id, "mutation"])),
  ...Object.fromEntries(PROPERTY_TOOLS.map((id) => [id, "mutation"])),
  ...Object.fromEntries(CONTROL_TOOLS.map((id) => [id, "control"])),
};

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalizeToBytes(value)).digest("hex");
}

export function publicToolBehavior(contract: PublicToolContract): PublicToolBehavior {
  const { contractHash: _contractHash, ...behavior } = contract;
  return PublicToolBehaviorSchema.parse(behavior);
}

export function hashPublicToolBehavior(behavior: PublicToolBehavior): string {
  return sha256Canonical(PublicToolBehaviorSchema.parse(behavior));
}

export function hashPublicToolManifest(manifest: Pick<PublicToolManifest, "schemaVersion" | "tools">): string {
  return sha256Canonical({ schemaVersion: manifest.schemaVersion, tools: manifest.tools });
}

function expectedOperationNames(contract: PublicToolContract): string[] {
  const properties = contract.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !("operation" in properties)) return ["*"];
  const operation = properties.operation;
  if (!operation || typeof operation !== "object" || Array.isArray(operation) || !("enum" in operation)) return ["*"];
  const values = operation.enum;
  return Array.isArray(values) && values.every((value) => typeof value === "string") ? [...values] : ["*"];
}

function validateContract(contract: PublicToolContract): void {
  const properties = contract.inputSchema.properties;
  const schemaFields = properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties).sort()
    : [];
  if (schemaFields.join("\0") !== [...contract.allowedInputFields].sort().join("\0")) {
    throw new Error(`public tool ${contract.name} allowed input fields do not match its input schema`);
  }
  const classifiedFields = contract.inputFields.map((field) => field.jsonPointer.slice(1)).sort();
  if (schemaFields.join("\0") !== classifiedFields.join("\0")) {
    throw new Error(`public tool ${contract.name} input data classifications do not match its input schema`);
  }
  if (expectedOperationNames(contract).sort().join("\0") !== Object.keys(contract.operations).sort().join("\0")) {
    throw new Error(`public tool ${contract.name} operation map does not match its input schema`);
  }
  if (contract.contractHash !== hashPublicToolBehavior(publicToolBehavior(contract))) {
    throw new Error(`public tool ${contract.name} contract hash mismatch`);
  }
}

function loadCanonicalManifest(): PublicToolManifest {
  const manifest = PublicToolManifestSchema.parse(manifestJson);
  const names = manifest.tools.map((tool) => tool.name);
  const expectedNames = [...ALL_PUBLIC_TOOLS].sort();
  if (new Set(names).size !== names.length) throw new Error("public tool manifest has duplicate names");
  if (names.join("\0") !== [...names].sort().join("\0")) throw new Error("public tool manifest tools must be sorted by name");
  if (names.join("\0") !== expectedNames.join("\0")) throw new Error("public tool manifest does not contain the exact Gateway catalog");
  for (const contract of manifest.tools) validateContract(contract);
  if (manifest.manifestHash !== hashPublicToolManifest(manifest)) throw new Error("public tool manifest hash mismatch");
  return manifest;
}

export const PUBLIC_TOOL_MANIFEST = loadCanonicalManifest();
export const PUBLIC_TOOL_BY_NAME: Readonly<Record<string, PublicToolContract>> = Object.freeze(
  Object.fromEntries(PUBLIC_TOOL_MANIFEST.tools.map((tool) => [tool.name, tool])),
);
export const ALLOWED_INPUTS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze(
  Object.fromEntries(PUBLIC_TOOL_MANIFEST.tools.map((tool) => [tool.name, new Set(tool.allowedInputFields)])),
);
