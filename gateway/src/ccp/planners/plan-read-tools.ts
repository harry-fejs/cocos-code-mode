import { CcpError } from "../errors.ts";
import { PrimitiveCommandSchema, type PrimitiveCommand, type PrimitiveValueRef } from "../primitive-contract.ts";
import type { PlannerContext } from "../protected-tool-registry.ts";
import type { GatewayDecision } from "../protocol.ts";
import { finiteString, inputObject, operationName, planCommands, requestPointer, requestValue } from "./planner-helpers.ts";

function optional(inputs: Record<string, unknown>, field: string): PrimitiveValueRef | undefined {
  return Object.prototype.hasOwnProperty.call(inputs, field) ? requestValue(field) : undefined;
}

function entity(field: string) {
  return requestValue(`${field}/id`);
}


function assetQuery(context: PlannerContext, action: "tree" | "at-path" | "resolve" | "search" | "available-url"): GatewayDecision {
  const inputs = inputObject(context);
  const args = {
    action,
    target: Object.prototype.hasOwnProperty.call(inputs, "reference") ? entity("reference") : undefined,
    assetPath: optional(inputs, "assetPath"),
    maxDepth: optional(inputs, "maxDepth"),
    maxNodes: optional(inputs, "maxNodes"),
    verbose: optional(inputs, "verbose"),
    pattern: optional(inputs, "pattern"),
    ccType: optional(inputs, "ccType"),
    importer: optional(inputs, "importer"),
    extname: optional(inputs, "extname"),
    isBundle: optional(inputs, "isBundle"),
    limit: optional(inputs, "limit"),
  };
  const command: PrimitiveCommand = { op: "asset.query", commandId: "asset-query", usesHandles: [], args };
  return planCommands(context, [command]);
}

function sceneReadNode(context: PlannerContext, action: "scene-info" | "by-asset" | "missing-assets" | "find" | "tree" | "at-path"): GatewayDecision {
  const inputs = inputObject(context);
  const fields = Array.isArray(inputs.fields) ? inputs.fields.map((_, index) => requestPointer(`/inputs/fields/${index}`)) : undefined;
  const command: PrimitiveCommand = {
    op: "scene.readNode", commandId: "scene-read", usesHandles: [],
    args: {
      action,
      target: Object.prototype.hasOwnProperty.call(inputs, "reference") ? entity("reference") : undefined,
      name: optional(inputs, "name"),
      componentType: optional(inputs, "componentType"),
      maxResults: optional(inputs, "maxResults"),
      maxDepth: optional(inputs, "maxDepth"),
      maxNodes: optional(inputs, "maxNodes"),
      verbose: optional(inputs, "verbose"),
      fields,
      hierarchyPath: optional(inputs, "hierarchyPath"),
      limit: optional(inputs, "limit"),
    },
  };
  return planCommands(context, [command]);
}

function componentRead(context: PlannerContext, action: "types" | "on-node"): GatewayDecision {
  const inputs = inputObject(context);
  const command: PrimitiveCommand = {
    op: "scene.readComponent", commandId: "component-read", usesHandles: [],
    args: {
      action,
      target: Object.prototype.hasOwnProperty.call(inputs, "reference") ? entity("reference") : undefined,
      componentType: optional(inputs, "componentType"),
      includeInternal: optional(inputs, "includeInternal"),
      filter: optional(inputs, "filter"),
      limit: optional(inputs, "limit"),
    },
  };
  return planCommands(context, [command]);
}



function materialRead(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const operation = finiteString(operationName(context), ["effects", "effect", "material", "serialized_material", "render_pipeline", "physics_material"] as const, "Material operation");
  const command: PrimitiveCommand = {
    op: "material.query", commandId: "material-query", usesHandles: [],
    args: {
      operation,
      target: Object.prototype.hasOwnProperty.call(inputs, "reference") ? entity("reference") : undefined,
      effectName: optional(inputs, "effectName"),
      limit: optional(inputs, "limit"),
    },
  };
  return planCommands(context, [command]);
}

function animationRead(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const query = finiteString(operationName(context), ["root_info", "root", "edit_info", "clips_info", "clip_dump", "properties", "state", "current_info", "clip_time", "value_at_frame"] as const, "Animation query");
  const valueFields = ["includeCurves", "maxCurves", "nodePath", "propKey", "frame"];
  const values = valueFields.filter((field) => Object.prototype.hasOwnProperty.call(inputs, field)).map(requestValue);
  const command: PrimitiveCommand = {
    op: "animation.query", commandId: "animation-query", usesHandles: [],
    args: {
      query,
      target: Object.prototype.hasOwnProperty.call(inputs, "nodeReference") ? entity("nodeReference") : undefined,
      clip: Object.prototype.hasOwnProperty.call(inputs, "clipReference") ? entity("clipReference") : undefined,
      values,
    },
  };
  return planCommands(context, [command]);
}

function editorRead(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const category = finiteString(inputs.category, ["scene_mode", "ready", "enum_values", "layers", "sorting_layers", "script_info", "has_script", "creatable_assets", "asset_types", "importers", "shared_settings", "sorted_plugins"] as const, "Editor query category");
  const command: PrimitiveCommand = {
    op: "editor.query", commandId: "editor-query", usesHandles: [],
    args: {
      category,
      enumPath: optional(inputs, "enumPath"),
      className: optional(inputs, "className"),
      target: Object.prototype.hasOwnProperty.call(inputs, "reference") ? entity("reference") : undefined,
    },
  };
  return planCommands(context, [command]);
}

function assetBatchRead(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const queries = inputs.queries as Array<Record<string, unknown>>;
  const fields = ["pattern", "ccType", "importer", "extname", "isBundle", "limit"] as const;
  const commands: PrimitiveCommand[] = queries.map((query, index) => {
    const args: Record<string, unknown> = { action: "search" };
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(query, field)) args[field] = requestPointer(`/inputs/queries/${index}/${field}`);
    }
    return PrimitiveCommandSchema.parse({ op: "asset.query", commandId: `asset-batch-${index}`, usesHandles: [], args });
  });
  return planCommands(context, commands, commands.map((command) => command.commandId));
}

export function planReadTool(context: PlannerContext): GatewayDecision {
  switch (context.request.tool.id) {
    case "assetGetTree": return assetQuery(context, "tree");
    case "assetGetAtPath": return assetQuery(context, "at-path");
    case "assetResolvePath": return assetQuery(context, "resolve");
    case "assetQuery": return assetQuery(context, "search");
    case "assetGetAvailableUrl": return assetQuery(context, "available-url");
    case "nodeGetAvailableComponentTypes": return componentRead(context, "types");
    case "nodeComponentsGet": return componentRead(context, "on-node");
    case "sceneGetInfo": return sceneReadNode(context, "scene-info");
    case "findNodesByAsset": return sceneReadNode(context, "by-asset");
    case "findNodesWithMissingAssets": return sceneReadNode(context, "missing-assets");
    case "findNodes": return sceneReadNode(context, "find");
    case "nodeGetTree": return sceneReadNode(context, "tree");
    case "nodeGetAtPath": return sceneReadNode(context, "at-path");
    case "animationQuery": return animationRead(context);
    case "materialQuery": return materialRead(context);
    case "editorQuery": return editorRead(context);
    case "assetBatchQuery": return assetBatchRead(context);
    case "getPerformanceSnapshot": return planCommands(context, [{ op: "scene.performanceSnapshot", commandId: "performance", usesHandles: [], args: {} }]);
    default: throw new CcpError("CCP_CONTRACT_MISMATCH", "Read planner has no finite tool branch.");
  }
}
