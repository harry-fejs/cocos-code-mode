import { CcpError } from "../errors.ts";
import type { PrimitiveCommand, PrimitiveValueRef } from "../primitive-contract.ts";
import type { PlannerContext } from "../protected-tool-registry.ts";
import type { GatewayDecision } from "../protocol.ts";
import { finiteString, inputObject, operationName, planCommands, requestPointer, requestValue } from "./planner-helpers.ts";

function optional(inputs: Record<string, unknown>, field: string): PrimitiveValueRef | undefined {
  return Object.prototype.hasOwnProperty.call(inputs, field) ? requestValue(field) : undefined;
}

function nodeOperate(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["move", "copy", "delete", "lock", "unlock", "create_prefab", "link_prefab", "revert_prefab", "apply_prefab", "unwrap_prefab", "unwrap_prefab_completely", "open_prefab"] as const, "Node operation");
  if (action === "copy" && Object.prototype.hasOwnProperty.call(inputs, "siblingIndex")
    && !Object.prototype.hasOwnProperty.call(inputs, "newParentReference")) {
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "copy with siblingIndex requires newParentReference for finite execution.");
  }
  const command: PrimitiveCommand = {
    op: "scene.operateNode", commandId: "node-operation", usesHandles: [],
    ...(action === "copy" ? { createsHandle: "copied-node" } : {}),
    args: {
      action,
      target: requestValue("reference/id"),
      destination: Object.prototype.hasOwnProperty.call(inputs, "newParentReference") ? requestValue("newParentReference/id") : undefined,
      prefabAsset: Object.prototype.hasOwnProperty.call(inputs, "prefabAssetReference") ? requestValue("prefabAssetReference/id") : undefined,
      prefabPath: optional(inputs, "newPrefabPath"),
      siblingIndex: optional(inputs, "siblingIndex"),
      recursive: optional(inputs, "recursive"),
    },
  };
  return planCommands(context, [command], [command.commandId]);
}

function nodeReset(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["node", "component", "property"] as const, "Reset operation");
  const references = inputs.references as unknown[];
  const command: PrimitiveCommand = {
    op: "scene.reset", commandId: "reset", usesHandles: [],
    args: {
      action,
      targets: references.map((_, index) => requestPointer(`/inputs/references/${index}/id`)),
      propertyPath: optional(inputs, "propertyPath"),
    },
  };
  return planCommands(context, [command]);
}

function inspectorSet(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const plural = Array.isArray(inputs.propertyPaths);
  const paths = plural ? inputs.propertyPaths as unknown[] : [inputs.propertyPath];
  const values = plural ? inputs.values as unknown[] : [inputs.value];
  const command: PrimitiveCommand = {
    op: "scene.setProperties", commandId: "set-properties", usesHandles: [],
    args: {
      target: inputs.target === "instance" ? requestValue("reference/id") : requestValue("target"),
      values: paths.map((_, index) => ({
        property: plural ? requestPointer(`/inputs/propertyPaths/${index}`) : requestValue("propertyPath"),
        value: plural ? requestPointer(`/inputs/values/${index}`) : requestValue("value"),
      })),
    },
  };
  if (paths.length !== values.length) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Property paths and values differ in length.");
  return planCommands(context, [command]);
}

function nodeBatchSet(context: PlannerContext): GatewayDecision {
  const entries = inputObject(context).entries as Array<Record<string, unknown>>;
  const commands: PrimitiveCommand[] = entries.map((entry, entryIndex) => {
    const paths = entry.propertyPaths as unknown[];
    const values = entry.values as unknown[];
    if (paths.length !== values.length) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Property paths and values differ in length.");
    return {
      op: "scene.setProperties", commandId: `batch-set-${entryIndex}`, usesHandles: [],
      args: {
        target: requestPointer(`/inputs/entries/${entryIndex}/reference/id`),
        values: paths.map((_, valueIndex) => ({
          property: requestPointer(`/inputs/entries/${entryIndex}/propertyPaths/${valueIndex}`),
          value: requestPointer(`/inputs/entries/${entryIndex}/values/${valueIndex}`),
        })),
      },
    };
  });
  return planCommands(context, commands);
}

function componentManage(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["add", "remove"] as const, "Component operation");
  const command: PrimitiveCommand = action === "add" ? {
    op: "scene.addComponent", commandId: "add-component", usesHandles: [], createsHandle: "component",
    args: { target: requestValue("reference/id"), componentType: requestValue("componentType") },
  } : {
    op: "scene.removeComponent", commandId: "remove-component", usesHandles: [],
    args: { target: requestValue("reference/id"), componentType: optional(inputs, "componentType") },
  };
  return planCommands(context, [command], [command.commandId]);
}

function projectSetting(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["get", "set"] as const, "Project setting operation");
  if (action === "get") {
    const command: PrimitiveCommand = {
      op: "project.readSetting", commandId: "read-setting", usesHandles: [],
      args: { namespace: optional(inputs, "type"), key: optional(inputs, "key"), limit: optional(inputs, "limit") },
    };
    return planCommands(context, [command]);
  }
  const args = Object.prototype.hasOwnProperty.call(inputs, "value")
    ? { path: requestValue("path"), value: requestValue("value") }
    : { path: requestValue("path") };
  const command: PrimitiveCommand = {
    op: "project.writeSetting", commandId: "write-setting", usesHandles: [], args,
  };
  return planCommands(context, [command]);
}

function animationEdit(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["record_start", "record_stop", "change_root", "set_edit_clip", "set_edit_time", "clip_state", "save_clip"] as const, "Animation edit operation");
  const valueFields: Partial<Record<typeof action, readonly string[]>> = {
    set_edit_time: ["time"], clip_state: ["clipState"],
  };
  const command: PrimitiveCommand = {
    op: "animation.edit", commandId: "animation-edit", usesHandles: [],
    args: {
      action,
      target: Object.prototype.hasOwnProperty.call(inputs, "nodeReference") ? requestValue("nodeReference/id") : undefined,
      clip: Object.prototype.hasOwnProperty.call(inputs, "clipReference") ? requestValue("clipReference/id") : undefined,
      values: (valueFields[action] ?? []).map(requestValue),
    },
  };
  return planCommands(context, [command], [command.commandId]);
}

function arrayElement(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["remove", "move"] as const, "Array operation");
  const command: PrimitiveCommand = {
    op: "scene.arrayElement", commandId: "array-element", usesHandles: [],
    args: {
      action,
      target: requestValue("reference/id"),
      propertyPath: requestValue("propertyPath"),
      index: requestValue("index"),
      toIndex: optional(inputs, "toIndex"),
    },
  };
  return planCommands(context, [command]);
}

function clipboard(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["copy", "cut", "paste"] as const, "Clipboard operation");
  const references = inputs.references as unknown[];
  const command: PrimitiveCommand = {
    op: "scene.clipboard", commandId: "clipboard", usesHandles: [],
    args: {
      action,
      targets: references.map((_, index) => requestPointer(`/inputs/references/${index}/id`)),
      destination: Object.prototype.hasOwnProperty.call(inputs, "targetReference") ? requestValue("targetReference/id") : undefined,
      keepWorldTransform: optional(inputs, "keepWorldTransform"),
      pasteAsChild: optional(inputs, "pasteAsChild"),
    },
  };
  return planCommands(context, [command]);
}

function sceneLifecycle(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["open", "save", "save_as", "close", "soft_reload"] as const, "Scene lifecycle operation");
  const command: PrimitiveCommand = {
    op: "scene.lifecycle", commandId: "scene-lifecycle", usesHandles: [],
    args: { action, target: Object.prototype.hasOwnProperty.call(inputs, "reference") ? requestValue("reference/id") : undefined },
  };
  return planCommands(context, [command], [command.commandId]);
}

export function planMutationTool(context: PlannerContext): GatewayDecision {
  switch (context.request.tool.id) {
    case "nodeOperate": return nodeOperate(context);
    case "nodeReset": return nodeReset(context);
    case "inspectorSet": return inspectorSet(context);
    case "nodeBatchSet": return nodeBatchSet(context);
    case "nodeComponentManage": return componentManage(context);
    case "projectManage": return projectSetting(context);
    case "animationEdit": return animationEdit(context);
    case "propertyArrayElement": return arrayElement(context);
    case "nodeClipboard": return clipboard(context);
    case "sceneManage": return sceneLifecycle(context);
    default: throw new CcpError("CCP_CONTRACT_MISMATCH", "Mutation planner has no finite tool branch.");
  }
}
