import { CcpError } from "../errors.ts";
import type { PrimitiveCommand, PrimitiveValueRef } from "../primitive-contract.ts";
import type { PlannerContext } from "../protected-tool-registry.ts";
import type { GatewayDecision } from "../protocol.ts";
import { contractConstant, handleValue, inputObject, observationValue, planCommands, requestValue } from "./planner-helpers.ts";

function nodeName(inputs: Record<string, unknown>, fallback: PrimitiveValueRef): PrimitiveValueRef {
  return Object.prototype.hasOwnProperty.call(inputs, "name") ? requestValue("name") : fallback;
}

function parent(inputs: Record<string, unknown>, fallback: "sceneRoot" | "root") {
  return Object.prototype.hasOwnProperty.call(inputs, "parentReference") ? requestValue("parentReference/id") : observationValue(fallback);
}

function createUiNode(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  if (typeof inputs.uiType !== "string") throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "UI type is required.");
  const command: PrimitiveCommand = {
    op: "scene.createNode", commandId: "create-ui-node", usesHandles: [], createsHandle: "ui-node",
    args: {
      parent: parent(inputs, "sceneRoot"),
      name: nodeName(inputs, requestValue("uiType")),
      prefab: contractConstant(`prefabByUiType.${inputs.uiType}`),
    },
  };
  return planCommands(context, [command], [command.commandId]);
}

function createNode(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const command: PrimitiveCommand = {
    op: "scene.createNode", commandId: "create-node", usesHandles: [], createsHandle: "node",
    args: {
      parent: parent(inputs, "root"),
      name: requestValue("name"),
      asset: Object.prototype.hasOwnProperty.call(inputs, "assetReference") ? requestValue("assetReference/id") : undefined,
      unwrapPrefab: Object.prototype.hasOwnProperty.call(inputs, "unwrapPrefab") ? requestValue("unwrapPrefab") : undefined,
    },
  };
  return planCommands(context, [command], [command.commandId]);
}

function propertyWrites(inputs: Record<string, unknown>, fields: readonly string[], constantRoot: string) {
  return fields.flatMap((field, index) => Object.prototype.hasOwnProperty.call(inputs, field)
    ? [{ property: contractConstant(`${constantRoot}.${index}`), value: requestValue(field) }]
    : []);
}

function createLabel(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const create: PrimitiveCommand = {
    op: "scene.createNode", commandId: "create-label", usesHandles: [], createsHandle: "label-node",
    args: { parent: parent(inputs, "sceneRoot"), name: nodeName(inputs, contractConstant("defaultName")), prefab: contractConstant("prefab") },
  };
  const commands: PrimitiveCommand[] = [create];
  const values = propertyWrites(inputs, ["text", "fontSize", "color"], "propertyPaths");
  if (values.length > 0) commands.push({
    op: "scene.setProperties", commandId: "configure-label", usesHandles: ["label-node"],
    args: { target: handleValue("label-node"), values },
  });
  return planCommands(context, commands, [create.commandId]);
}

function createSprite(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const create: PrimitiveCommand = {
    op: "scene.createNode", commandId: "create-sprite", usesHandles: [], createsHandle: "sprite-node",
    args: { parent: parent(inputs, "sceneRoot"), name: nodeName(inputs, contractConstant("defaultName")), prefab: contractConstant("prefab") },
  };
  const commands: PrimitiveCommand[] = [create];
  if (Object.prototype.hasOwnProperty.call(inputs, "spriteFrameUuid")) commands.push({
    op: "scene.setProperties", commandId: "configure-sprite", usesHandles: ["sprite-node"],
    args: {
      target: handleValue("sprite-node"),
      values: [{ property: contractConstant("propertyPath"), value: requestValue("spriteFrameUuid") }],
    },
  });
  return planCommands(context, commands, [create.commandId]);
}

function createButton(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const commands: PrimitiveCommand[] = [{
    op: "scene.createNode", commandId: "create-button", usesHandles: [], createsHandle: "button-node",
    args: { parent: parent(inputs, "sceneRoot"), name: nodeName(inputs, contractConstant("defaultName")), prefab: contractConstant("prefab") },
  }];
  if (Object.prototype.hasOwnProperty.call(inputs, "text")) {
    commands.push({
      op: "scene.readNode", commandId: "locate-button-label", usesHandles: ["button-node"],
      args: { action: "at-path", target: handleValue("button-node"), hierarchyPath: contractConstant("labelChildName") },
    }, {
      op: "scene.setProperties", commandId: "configure-button-label", usesHandles: ["button-node"],
      args: {
        target: handleValue("button-node"),
        values: [{ property: contractConstant("labelPropertyPath"), value: requestValue("text") }],
      },
    });
  }
  return planCommands(context, commands, ["create-button"]);
}

function createPrimitive(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const command: PrimitiveCommand = {
    op: "scene.createPrimitive", commandId: "create-primitive", usesHandles: [], createsHandle: "primitive-node",
    args: { parent: parent(inputs, "root"), primitive: requestValue("primitiveType"), name: requestValue("name") },
  };
  return planCommands(context, [command], [command.commandId]);
}

export function planCreateTool(context: PlannerContext): GatewayDecision {
  switch (context.request.tool.id) {
    case "createUiNode": return createUiNode(context);
    case "nodeCreate": return createNode(context);
    case "createLabel": return createLabel(context);
    case "createButton": return createButton(context);
    case "createSprite": return createSprite(context);
    case "nodeCreatePrimitive": return createPrimitive(context);
    default: throw new CcpError("CCP_CONTRACT_MISMATCH", "Create planner has no finite tool branch.");
  }
}
