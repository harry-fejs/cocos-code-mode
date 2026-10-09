import { z } from "zod";

export const EffectSchema = z.enum(["none", "local-state", "project-write", "external-side-effect"]);
export type Effect = z.infer<typeof EffectSchema>;

export const PUBLIC_VALUE_SOURCES = ["request", "observation", "public-contract-constant", "handle"] as const;
export const PUBLIC_PRIMITIVE_IDS = [
  "scene.readNode", "scene.readComponent", "scene.createNode",
  "scene.createPrimitive", "scene.addComponent", "scene.removeComponent", "scene.setProperties",
  "scene.operateNode", "scene.reset", "scene.arrayElement", "scene.clipboard", "scene.lifecycle",
  "scene.performanceSnapshot", "asset.query", "asset.operate", "material.query",
  "project.readSetting", "project.writeSetting", "editor.query", "editor.selection", "editor.viewport",
  "editor.history", "animation.query", "animation.edit",
  "build.openPanel", "build.query", "build.start", "build.control", "runtime.control",
  "runtime.simulateButtonClick",
] as const;

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const jsonPointer = z.string().min(1).max(1024).regex(/^(?:\/(?:[^~/]|~0|~1)*)+$/);
const requestValue = z.object({ source: z.literal("request"), jsonPointer }).strict();
const observationValue = z.object({ source: z.literal("observation"), jsonPointer }).strict();
const contractConstant = z.object({ source: z.literal("public-contract-constant"), id: identifier }).strict();
export const PrimitiveValueRefSchema = z.discriminatedUnion("source", [requestValue, observationValue, contractConstant]);
export type PrimitiveValueRef = z.infer<typeof PrimitiveValueRefSchema>;

const handleRef = z.object({ source: z.literal("handle"), handle: identifier }).strict();
export const EntityRefSchema = z.union([requestValue, observationValue, handleRef]);
export type EntityRef = z.infer<typeof EntityRefSchema>;

const command = <TOp extends string, T extends z.ZodRawShape>(op: TOp, args: T) => z.object({
  op: z.literal(op), commandId: identifier, usesHandles: z.array(identifier).max(16),
  createsHandle: identifier.optional(), args: z.object(args).strict(),
}).strict();
const propertyWrite = z.object({ property: PrimitiveValueRefSchema, value: PrimitiveValueRefSchema }).strict();

const sceneReadNode = command("scene.readNode", {
  action: z.enum(["scene-info", "by-asset", "missing-assets", "find", "tree", "at-path"]),
  target: EntityRefSchema.optional(),
  name: PrimitiveValueRefSchema.optional(),
  componentType: PrimitiveValueRefSchema.optional(),
  maxResults: PrimitiveValueRefSchema.optional(),
  maxDepth: PrimitiveValueRefSchema.optional(),
  maxNodes: PrimitiveValueRefSchema.optional(),
  verbose: PrimitiveValueRefSchema.optional(),
  fields: z.array(PrimitiveValueRefSchema).max(100).optional(),
  hierarchyPath: PrimitiveValueRefSchema.optional(),
  limit: PrimitiveValueRefSchema.optional(),
});
const sceneReadComponent = command("scene.readComponent", {
  action: z.enum(["types", "on-node"]),
  target: EntityRefSchema.optional(),
  componentType: PrimitiveValueRefSchema.optional(),
  includeInternal: PrimitiveValueRefSchema.optional(),
  filter: PrimitiveValueRefSchema.optional(),
  limit: PrimitiveValueRefSchema.optional(),
});
const sceneCreateNode = command("scene.createNode", { parent: EntityRefSchema.optional(), name: PrimitiveValueRefSchema, asset: EntityRefSchema.optional(), prefab: contractConstant.optional(), unwrapPrefab: PrimitiveValueRefSchema.optional() });
const sceneCreatePrimitive = command("scene.createPrimitive", { parent: EntityRefSchema.optional(), primitive: PrimitiveValueRefSchema, name: PrimitiveValueRefSchema.optional() });
const sceneAddComponent = command("scene.addComponent", { target: EntityRefSchema, componentType: PrimitiveValueRefSchema });
const sceneRemoveComponent = command("scene.removeComponent", { target: EntityRefSchema, componentType: PrimitiveValueRefSchema.optional() });
const sceneSetProperties = command("scene.setProperties", { target: EntityRefSchema, values: z.array(propertyWrite).min(1).max(100) });
const sceneOperateNode = command("scene.operateNode", {
  target: EntityRefSchema,
  action: z.enum(["move", "copy", "delete", "lock", "unlock", "create_prefab", "link_prefab", "revert_prefab", "apply_prefab", "unwrap_prefab", "unwrap_prefab_completely", "open_prefab"]),
  destination: EntityRefSchema.optional(),
  prefabAsset: EntityRefSchema.optional(),
  prefabPath: PrimitiveValueRefSchema.optional(),
  siblingIndex: PrimitiveValueRefSchema.optional(),
  recursive: PrimitiveValueRefSchema.optional(),
});
const sceneReset = command("scene.reset", { action: z.enum(["node", "component", "property"]), targets: z.array(EntityRefSchema).min(1).max(100), propertyPath: PrimitiveValueRefSchema.optional() });
const sceneArrayElement = command("scene.arrayElement", { action: z.enum(["remove", "move"]), target: EntityRefSchema, propertyPath: PrimitiveValueRefSchema, index: PrimitiveValueRefSchema, toIndex: PrimitiveValueRefSchema.optional() });
const sceneClipboard = command("scene.clipboard", { action: z.enum(["copy", "cut", "paste"]), targets: z.array(EntityRefSchema).min(1).max(256), destination: EntityRefSchema.optional(), keepWorldTransform: PrimitiveValueRefSchema.optional(), pasteAsChild: PrimitiveValueRefSchema.optional() });
const sceneLifecycle = command("scene.lifecycle", { action: z.enum(["open", "save", "save_as", "close", "soft_reload"]), target: EntityRefSchema.optional() });
const scenePerformanceSnapshot = command("scene.performanceSnapshot", {});
const assetQuery = command("asset.query", {
  action: z.enum(["tree", "at-path", "resolve", "search", "available-url"]),
  target: EntityRefSchema.optional(),
  assetPath: PrimitiveValueRefSchema.optional(),
  maxDepth: PrimitiveValueRefSchema.optional(),
  maxNodes: PrimitiveValueRefSchema.optional(),
  verbose: PrimitiveValueRefSchema.optional(),
  pattern: PrimitiveValueRefSchema.optional(),
  ccType: PrimitiveValueRefSchema.optional(),
  importer: PrimitiveValueRefSchema.optional(),
  extname: PrimitiveValueRefSchema.optional(),
  isBundle: PrimitiveValueRefSchema.optional(),
  limit: PrimitiveValueRefSchema.optional(),
});
const assetOperate = command("asset.operate", { target: EntityRefSchema, action: z.enum(["move", "copy", "delete", "open", "refresh", "reimport"]), destination: PrimitiveValueRefSchema.optional() });
const materialQuery = command("material.query", { operation: z.enum(["effects", "effect", "material", "serialized_material", "render_pipeline", "physics_material"]), target: EntityRefSchema.optional(), effectName: PrimitiveValueRefSchema.optional(), limit: PrimitiveValueRefSchema.optional() });
const projectReadSetting = command("project.readSetting", { namespace: PrimitiveValueRefSchema.optional(), key: PrimitiveValueRefSchema.optional(), limit: PrimitiveValueRefSchema.optional() });
const projectWriteSetting = command("project.writeSetting", { path: PrimitiveValueRefSchema, value: PrimitiveValueRefSchema.optional() });
const editorQuery = command("editor.query", { category: z.enum(["scene_mode", "ready", "enum_values", "layers", "sorting_layers", "script_info", "has_script", "creatable_assets", "asset_types", "importers", "shared_settings", "sorted_plugins"]), enumPath: PrimitiveValueRefSchema.optional(), className: PrimitiveValueRefSchema.optional(), target: EntityRefSchema.optional() });
const editorSelection = command("editor.selection", { action: z.enum(["select", "unselect", "clear", "query", "select_all", "hover", "update"]), selectionType: z.enum(["node", "asset"]), targets: z.array(EntityRefSchema).max(256).optional() });
const editorViewport = command("editor.viewport", { action: z.enum(["focus", "set_2d_mode", "set_grid_visible", "set_icon_gizmo_3d", "set_icon_gizmo_size", "set_gizmo_tool", "set_gizmo_pivot", "set_gizmo_coordinate", "query_gizmo", "query_viewport", "align_view_to_selected_node", "align_selected_node_to_view"]), targets: z.array(EntityRefSchema).max(256).optional(), value: PrimitiveValueRefSchema.optional() });
const editorHistory = command("editor.history", { action: z.enum(["undo", "redo", "abort"]) });
const animationQuery = command("animation.query", { target: EntityRefSchema.optional(), clip: EntityRefSchema.optional(), query: z.enum(["root_info", "root", "edit_info", "clips_info", "clip_dump", "properties", "state", "current_info", "clip_time", "value_at_frame"]), values: z.array(PrimitiveValueRefSchema).max(8) });
const animationEdit = command("animation.edit", { target: EntityRefSchema.optional(), clip: EntityRefSchema.optional(), action: z.enum(["record_start", "record_stop", "change_root", "set_edit_clip", "set_edit_time", "clip_state", "save_clip"]), values: z.array(PrimitiveValueRefSchema).max(8) });
const buildOpenPanel = command("build.openPanel", { panel: z.enum(["default", "build-bundle"]) });
const buildQuery = command("build.query", { query: z.enum(["tasks", "task"]), taskId: PrimitiveValueRefSchema.optional(), limit: PrimitiveValueRefSchema.optional() });
const buildStart = command("build.start", { options: PrimitiveValueRefSchema });
const buildControl = command("build.control", { taskId: PrimitiveValueRefSchema, action: z.enum(["break", "remove", "recompile"]) });
const runtimeControl = command("runtime.control", { action: z.enum(["pause", "resume", "set-time-scale", "get-state"]), value: PrimitiveValueRefSchema.optional() });
const runtimeSimulateButtonClick = command("runtime.simulateButtonClick", { target: EntityRefSchema });

export const PrimitiveCommandSchema = z.discriminatedUnion("op", [
  sceneReadNode, sceneReadComponent, sceneCreateNode, sceneCreatePrimitive,
  sceneAddComponent, sceneRemoveComponent, sceneSetProperties, sceneOperateNode, sceneReset,
  sceneArrayElement, sceneClipboard, sceneLifecycle, scenePerformanceSnapshot, assetQuery,
  assetOperate, materialQuery, projectReadSetting,
  projectWriteSetting, editorQuery, editorSelection, editorViewport, editorHistory,
  animationQuery, animationEdit, buildOpenPanel, buildQuery, buildStart, buildControl,
  runtimeControl, runtimeSimulateButtonClick,
]);
export type PrimitiveCommand = z.infer<typeof PrimitiveCommandSchema>;

type CommandSemantics = { effect: Effect; createsHandle: boolean; ipcCount: number };
const fixedSemantics: Record<string, CommandSemantics> = {
  "scene.readComponent": { effect: "none", createsHandle: false, ipcCount: 1 },
  "scene.removeComponent": { effect: "project-write", createsHandle: false, ipcCount: 1 },
  "scene.reset": { effect: "project-write", createsHandle: false, ipcCount: 1 },
  "scene.arrayElement": { effect: "project-write", createsHandle: false, ipcCount: 1 },
  "scene.performanceSnapshot": { effect: "none", createsHandle: false, ipcCount: 1 },
  "material.query": { effect: "none", createsHandle: false, ipcCount: 1 },
  "project.readSetting": { effect: "none", createsHandle: false, ipcCount: 1 },
  "project.writeSetting": { effect: "project-write", createsHandle: false, ipcCount: 1 },
  "editor.query": { effect: "none", createsHandle: false, ipcCount: 1 },
  "animation.query": { effect: "none", createsHandle: false, ipcCount: 1 },
  "animation.edit": { effect: "project-write", createsHandle: false, ipcCount: 1 },
  "build.openPanel": { effect: "local-state", createsHandle: false, ipcCount: 1 },
  "build.start": { effect: "external-side-effect", createsHandle: false, ipcCount: 1 },
  "build.control": { effect: "external-side-effect", createsHandle: false, ipcCount: 1 },
  "runtime.simulateButtonClick": { effect: "external-side-effect", createsHandle: false, ipcCount: 2 },
};

export function primitiveCommandSemantics(command: PrimitiveCommand): CommandSemantics {
  if (command.op === "scene.readNode") return { effect: "none", createsHandle: false, ipcCount: command.args.action === "scene-info" ? 3 : 1 };
  if (command.op === "scene.setProperties") return { effect: "project-write", createsHandle: false, ipcCount: command.args.values.length };
  if (command.op === "scene.createNode") {
    return { effect: "project-write", createsHandle: true, ipcCount: 1 + (command.args.parent ? 0 : 1) + (command.args.asset ? 1 : 0) + (command.args.prefab ? 1 : 0) };
  }
  if (command.op === "scene.operateNode") {
    const { action } = command.args;
    const ipcCount = action === "open_prefab" ? 2
      : action === "create_prefab" ? 5
      : action === "move" ? (command.args.siblingIndex !== undefined ? 3 : 1)
      : action === "copy" ? 1 + (command.args.destination ? 1 : 0) + (command.args.siblingIndex !== undefined ? 2 : 0)
      : action === "delete" ? 2
      : 1;
    return { effect: action === "open_prefab" ? "local-state" : "project-write", createsHandle: action === "copy", ipcCount };
  }
  if (command.op === "scene.createPrimitive") return { effect: "project-write", createsHandle: true, ipcCount: command.args.parent ? 2 : 3 };
  if (command.op === "scene.addComponent") return { effect: "project-write", createsHandle: true, ipcCount: 3 };
  if (command.op === "scene.clipboard") return { effect: command.args.action === "copy" ? "local-state" : "project-write", createsHandle: false, ipcCount: 1 };
  if (command.op === "scene.lifecycle") return { effect: ["save", "save_as"].includes(command.args.action) ? "project-write" : "local-state", createsHandle: false, ipcCount: 1 };
  if (command.op === "asset.query") {
    const ipcCount = command.args.action === "tree" ? (command.args.target ? 4 : 3)
      : command.args.action === "search" ? 2 : 1;
    return { effect: "none", createsHandle: false, ipcCount };
  }
  if (command.op === "asset.operate") return { effect: ["open", "refresh"].includes(command.args.action) ? "local-state" : "project-write", createsHandle: command.args.action === "copy", ipcCount: 2 };
  if (command.op === "editor.query") return { effect: "none", createsHandle: false, ipcCount: command.args.category === "script_info" ? 2 : 1 };
  if (command.op === "editor.selection") return { effect: command.args.action === "query" ? "none" : "local-state", createsHandle: false, ipcCount: command.args.action === "select_all" ? 1 : 0 };
  if (command.op === "editor.viewport") {
    const ipcCount = command.args.action === "query_gizmo" ? 3 : command.args.action === "query_viewport" ? 4 : 1;
    return { effect: ["query_gizmo", "query_viewport"].includes(command.args.action) ? "none" : "local-state", createsHandle: false, ipcCount };
  }
  if (command.op === "editor.history") return { effect: command.args.action === "abort" ? "local-state" : "project-write", createsHandle: false, ipcCount: 1 };
  if (command.op === "build.query") return { effect: "none", createsHandle: false, ipcCount: command.args.query === "tasks" ? 2 : 1 };
  if (command.op === "runtime.control") return { effect: command.args.action === "get-state" ? "none" : "local-state", createsHandle: false, ipcCount: 1 };
  const semantics = fixedSemantics[command.op];
  if (!semantics) throw new Error(`missing primitive semantics: ${command.op}`);
  return semantics;
}

const effectRank: Record<Effect, number> = { none: 0, "local-state": 1, "project-write": 2, "external-side-effect": 3 };
function referencedHandles(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return found;
  if (!Array.isArray(value) && "source" in value && value.source === "handle" && "handle" in value && typeof value.handle === "string") found.add(value.handle);
  for (const child of Object.values(value)) referencedHandles(child, found);
  return found;
}

const precondition = z.object({ kind: z.enum(["observation", "entity", "lifecycle", "build-task"]), target: z.union([requestValue, observationValue]).optional(), revisionToken: z.string().min(1).max(512), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ExecutionEnvelopeSchema = z.object({
  effect: EffectSchema,
  commands: z.array(PrimitiveCommandSchema).min(1).max(100),
  preconditions: z.array(precondition).max(128),
  transaction: z.object({ mode: z.enum(["read", "ordered-effect"]), onError: z.literal("stop"), snapshot: z.enum(["none", "once-after-success", "once-after-partial-failure"]) }).strict(),
  return: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("command-result"), commandId: identifier }).strict(),
    z.object({ mode: z.literal("command-results"), commandIds: z.array(identifier).min(1).max(100) }).strict(),
    z.object({ mode: z.literal("execution-summary") }).strict(),
  ]),
  limits: z.object({ commandCount: z.number().int().min(1).max(100), ipcCount: z.number().int().min(0).max(10_001), inputBytes: z.number().int().min(0).max(262144), outputBytes: z.number().int().min(0).max(524288), timeoutMs: z.number().int().min(1).max(15000) }).strict(),
}).strict().superRefine((envelope, context) => {
  const issue = (message: string, path: (string | number)[]) => context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (envelope.commands.length !== envelope.limits.commandCount) issue("commandCount mismatch", ["limits", "commandCount"]);
  const commandIds = new Set<string>();
  const handles = new Set<string>();
  let requiredEffectRank = 0;
  let requiredIpc = envelope.transaction.snapshot === "none" ? 0 : 1;
  envelope.commands.forEach((entry, index) => {
    const semantics = primitiveCommandSemantics(entry);
    requiredEffectRank = Math.max(requiredEffectRank, effectRank[semantics.effect]);
    requiredIpc += semantics.ipcCount;
    if (commandIds.has(entry.commandId)) issue("duplicate commandId", ["commands", index, "commandId"]);
    commandIds.add(entry.commandId);
    const refs = [...referencedHandles(entry.args)].sort();
    const declared = [...entry.usesHandles].sort();
    if (new Set(entry.usesHandles).size !== entry.usesHandles.length || refs.join("\0") !== declared.join("\0")) issue("usesHandles mismatch", ["commands", index, "usesHandles"]);
    for (const handle of refs) if (!handles.has(handle)) issue("handle must be created by an earlier command", ["commands", index, "usesHandles"]);
    if (entry.op === "scene.operateNode" && entry.args.action === "move" && entry.args.destination === undefined) {
      issue("move requires destination", ["commands", index, "args", "destination"]);
    }
    if (entry.op === "scene.operateNode" && entry.args.action === "copy"
      && entry.args.siblingIndex !== undefined && entry.args.destination === undefined) {
      issue("copy with siblingIndex requires destination", ["commands", index, "args", "destination"]);
    }
    if (entry.op === "asset.operate" && (entry.args.action === "move" || entry.args.action === "copy") && entry.args.destination === undefined) {
      issue("asset relocate requires destination", ["commands", index, "args", "destination"]);
    }
    if (entry.op === "editor.selection" && ["select", "unselect", "update"].includes(entry.args.action) && (!entry.args.targets || entry.args.targets.length === 0)) {
      issue("selection operation requires targets", ["commands", index, "args", "targets"]);
    }
    if (entry.op === "build.control" && entry.args.taskId === undefined) {
      issue("build control requires taskId", ["commands", index, "args", "taskId"]);
    }
    if (entry.op === "runtime.control" && entry.args.action === "set-time-scale" && entry.args.value === undefined) {
      issue("set-time-scale requires value", ["commands", index, "args", "value"]);
    }
    if (semantics.createsHandle !== Boolean(entry.createsHandle)) issue(semantics.createsHandle ? "createsHandle required" : "createsHandle forbidden", ["commands", index, "createsHandle"]);
    if (entry.createsHandle) {
      if (handles.has(entry.createsHandle)) issue("duplicate createsHandle", ["commands", index, "createsHandle"]);
      handles.add(entry.createsHandle);
    }
  });
  const requiredEffect = (["none", "local-state", "project-write", "external-side-effect"] as const)[requiredEffectRank];
  if (envelope.effect !== requiredEffect) issue(`effect must be ${requiredEffect}`, ["effect"]);
  if (requiredEffect === "none" && envelope.transaction.mode !== "read") issue("none effect requires read transaction", ["transaction", "mode"]);
  if (requiredEffect !== "none" && envelope.transaction.mode !== "ordered-effect") issue("effect requires ordered transaction", ["transaction", "mode"]);
  if (requiredEffect !== "none" && envelope.preconditions.length === 0) issue("effect requires preconditions", ["preconditions"]);
  if (requiredEffect === "none" && envelope.transaction.snapshot !== "none") issue("read transaction cannot snapshot", ["transaction", "snapshot"]);
  if (requiredEffect === "project-write" && envelope.transaction.snapshot === "none") issue("project write requires snapshot", ["transaction", "snapshot"]);
  if (requiredEffect !== "project-write" && envelope.transaction.snapshot !== "none") issue("snapshot only valid for project write", ["transaction", "snapshot"]);
  if (envelope.limits.ipcCount !== requiredIpc) issue("ipcCount mismatch", ["limits", "ipcCount"]);
  if (envelope.return.mode === "command-result" && !commandIds.has(envelope.return.commandId)) issue("return commandId missing", ["return", "commandId"]);
  if (envelope.return.mode === "command-results") {
    if (new Set(envelope.return.commandIds).size !== envelope.return.commandIds.length) issue("return commandIds must be unique", ["return", "commandIds"]);
    envelope.return.commandIds.forEach((commandId, index) => {
      if (!commandIds.has(commandId)) issue("return commandId missing", ["return", "commandIds", index]);
    });
  }
});
export type ExecutionEnvelope = z.infer<typeof ExecutionEnvelopeSchema>;
