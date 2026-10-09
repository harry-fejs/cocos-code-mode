import { CcpError } from "../errors.ts";
import type { PrimitiveCommand, PrimitiveValueRef } from "../primitive-contract.ts";
import type { PlannerContext } from "../protected-tool-registry.ts";
import type { GatewayDecision } from "../protocol.ts";
import { finiteString, inputObject, operationName, planCommands, requestPointer, requestValue } from "./planner-helpers.ts";

function optional(inputs: Record<string, unknown>, field: string): PrimitiveValueRef | undefined {
  return Object.prototype.hasOwnProperty.call(inputs, field) ? requestValue(field) : undefined;
}

function runtime(context: PlannerContext, action: "pause" | "resume" | "set-time-scale" | "get-state"): GatewayDecision {
  const inputs = inputObject(context);
  const command: PrimitiveCommand = {
    op: "runtime.control", commandId: "runtime-control", usesHandles: [],
    args: { action, value: action === "set-time-scale" ? requestValue("scale") : undefined },
  };
  if (Object.keys(inputs).length > (action === "set-time-scale" ? 1 : 0)) {
    throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Runtime control received unexpected inputs.");
  }
  return planCommands(context, [command], [command.commandId]);
}

function history(context: PlannerContext): GatewayDecision {
  const action = finiteString(operationName(context), ["undo", "redo", "abort"] as const, "History operation");
  const command: PrimitiveCommand = { op: "editor.history", commandId: "history", usesHandles: [], args: { action } };
  return planCommands(context, [command]);
}

function selection(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["select", "unselect", "clear", "query", "select_all", "hover", "update"] as const, "Selection operation");
  const references = Array.isArray(inputs.references) ? inputs.references : undefined;
  const selectionType = typeof inputs.selectionType === "string"
    ? finiteString(inputs.selectionType, ["node", "asset"] as const, "Selection type")
    : "node";
  const command: PrimitiveCommand = {
    op: "editor.selection", commandId: "selection", usesHandles: [],
    args: {
      action,
      selectionType,
      targets: references?.map((_, index) => requestPointer(`/inputs/references/${index}/id`)),
    },
  };
  return planCommands(context, [command], [command.commandId]);
}

function viewport(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const action = finiteString(operationName(context), ["focus", "set_2d_mode", "set_grid_visible", "set_icon_gizmo_3d", "set_icon_gizmo_size", "set_gizmo_tool", "set_gizmo_pivot", "set_gizmo_coordinate", "query_gizmo", "query_viewport", "align_view_to_selected_node", "align_selected_node_to_view"] as const, "Viewport operation");
  const valueField: Partial<Record<typeof action, string>> = {
    set_2d_mode: "enabled", set_grid_visible: "enabled", set_icon_gizmo_3d: "enabled",
    set_icon_gizmo_size: "size", set_gizmo_tool: "gizmoTool", set_gizmo_pivot: "gizmoPivot",
    set_gizmo_coordinate: "gizmoCoordinate",
  };
  const references = Array.isArray(inputs.references) ? inputs.references : undefined;
  const selectedValue = valueField[action];
  const command: PrimitiveCommand = {
    op: "editor.viewport", commandId: "viewport", usesHandles: [],
    args: {
      action,
      targets: references?.map((_, index) => requestPointer(`/inputs/references/${index}/id`)),
      value: selectedValue ? requestValue(selectedValue) : undefined,
    },
  };
  return planCommands(context, [command], [command.commandId]);
}

function build(context: PlannerContext): GatewayDecision {
  const inputs = inputObject(context);
  const operation = finiteString(operationName(context), ["panel_open", "tasks_info", "get_task", "trigger", "control"] as const, "Build operation");
  let command: PrimitiveCommand;
  if (operation === "panel_open") {
    const panel = typeof inputs.panel === "string" ? finiteString(inputs.panel, ["default", "build-bundle"] as const, "Build panel") : "default";
    command = { op: "build.openPanel", commandId: "build-panel", usesHandles: [], args: { panel } };
  } else if (operation === "tasks_info") {
    command = { op: "build.query", commandId: "build-tasks", usesHandles: [], args: { query: "tasks" } };
  } else if (operation === "get_task") {
    command = { op: "build.query", commandId: "build-task", usesHandles: [], args: { query: "task", taskId: requestValue("taskId") } };
  } else if (operation === "trigger") {
    command = { op: "build.start", commandId: "build-start", usesHandles: [], args: { options: requestValue("options") } };
  } else {
    const action = finiteString(inputs.control, ["break", "remove", "recompile"] as const, "Build control");
    command = { op: "build.control", commandId: "build-control", usesHandles: [], args: { taskId: requestValue("taskId"), action } };
  }
  return planCommands(context, [command], [command.commandId]);
}

function simulateButton(context: PlannerContext): GatewayDecision {
  const command: PrimitiveCommand = {
    op: "runtime.simulateButtonClick", commandId: "button-click", usesHandles: [],
    args: { target: requestValue("reference/id") },
  };
  return planCommands(context, [command], [command.commandId]);
}

export function planControlTool(context: PlannerContext): GatewayDecision {
  switch (context.request.tool.id) {
    case "runtimePause": return runtime(context, "pause");
    case "runtimeResume": return runtime(context, "resume");
    case "runtimeSetTimeScale": return runtime(context, "set-time-scale");
    case "runtimeGetState": return runtime(context, "get-state");
    case "editorHistory": return history(context);
    case "editorSelect": return selection(context);
    case "editorViewport": return viewport(context);
    case "buildManage": return build(context);
    case "simulateButtonClick": return simulateButton(context);
    default: throw new CcpError("CCP_CONTRACT_MISMATCH", "Control planner has no finite tool branch.");
  }
}
