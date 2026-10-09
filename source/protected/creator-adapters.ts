import { CcpError } from "./errors";
import type { PrimitiveCommand } from "./primitive-contract";

export type CreatorChannel = (module: string, message: string, ...args: unknown[]) => Promise<unknown>;
export interface CreatorLocalApis {
  selection: {
    select(type: "node" | "asset", values: string | string[]): void;
    unselect(type: "node" | "asset", values: string | string[]): void;
    clear(type: "node" | "asset"): void;
    hover(type: "node" | "asset", value?: string): void;
    update(type: "node" | "asset", values: string[]): void;
    getSelected(type: "node" | "asset"): string[];
    getLastSelected(type: "node" | "asset"): string | undefined;
  };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", `${label} must be a string.`);
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, label);
}

function reference(id: unknown, type: string): { reference: { id: string; type: string } } {
  if (Array.isArray(id)) id = id[0];
  return { reference: { id: text(id, "Creator result ID"), type } };
}


function creatorReference(value: unknown, fallbackType: string): { reference: { id: string; type: string } } {
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === "object") {
    const id = "uuid" in value ? value.uuid : "id" in value ? value.id : undefined;
    const type = "type" in value && typeof value.type === "string" && value.type ? value.type : fallbackType;
    return { reference: { id: text(id, "Creator result ID"), type } };
  }
  return reference(value, fallbackType);
}


function listLimit(value: unknown, fallback = 200, max = 1000): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(Math.max(value, 1), max) : fallback;
}

function normalizeComponents(node: unknown, filter: unknown): { references: Array<{ id: string; type?: string }> } {
  if (!node || typeof node !== "object" || Array.isArray(node) || !("__comps__" in node) || !Array.isArray(node.__comps__)) return { references: [] };
  const wanted = typeof filter === "string" ? filter : undefined;
  const references: Array<{ id: string; type?: string }> = [];
  for (const component of node.__comps__) {
    if (!component || typeof component !== "object") continue;
    const value = "value" in component && component.value && typeof component.value === "object" ? component.value : component;
    const id = "uuid" in value && value.uuid && typeof value.uuid === "object" && "value" in value.uuid ? value.uuid.value : "uuid" in value ? value.uuid : undefined;
    const type = "type" in component ? component.type : "__type__" in value ? value.__type__ : "cid" in value ? value.cid : undefined;
    if (typeof id === "string" && (!wanted || (typeof type === "string" && type.includes(wanted)))) references.push({ id, ...(typeof type === "string" ? { type } : {}) });
  }
  return { references };
}

function slimTask(task: unknown): unknown {
  if (!task || typeof task !== "object" || Array.isArray(task)) return task;
  const id = "id" in task ? task.id : undefined;
  const progress = "progress" in task ? task.progress : undefined;
  const state = "state" in task ? task.state : undefined;
  const message = "message" in task ? task.message : undefined;
  const options = "options" in task && task.options && typeof task.options === "object" && !Array.isArray(task.options) ? task.options : undefined;
  return {
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof progress === "number" ? { progress } : {}),
    ...(typeof state === "string" ? { state } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(options && "name" in options && typeof options.name === "string" ? { name: options.name } : {}),
    ...(options && "platform" in options && typeof options.platform === "string" ? { platform: options.platform } : {}),
  };
}

function boundedSceneTree(root: unknown, args: Record<string, unknown>): { tree: unknown; nodeCount: number; truncated?: string } {
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("Scene tree is unavailable.");
  const maxDepth = typeof args.maxDepth === "number" && Number.isInteger(args.maxDepth) ? Math.min(Math.max(args.maxDepth, 0), 99) : 4;
  const maxNodes = typeof args.maxNodes === "number" && Number.isInteger(args.maxNodes) ? Math.min(Math.max(args.maxNodes, 1), 5000) : 200;
  const requested = Array.isArray(args.fields) ? new Set(args.fields.filter((field): field is string => typeof field === "string")) : undefined;
  const want = (field: string) => !requested || requested.has(field);
  let remaining = maxNodes;
  let nodeCount = 0;
  let truncation: string | undefined;
  const visit = (node: unknown, depth: number): unknown => {
    if (!node || typeof node !== "object" || Array.isArray(node) || remaining <= 0) return null;
    remaining -= 1;
    nodeCount += 1;
    const raw = node as Record<string, unknown>;
    const id = typeof raw.uuid === "string" ? raw.uuid : typeof raw.id === "string" ? raw.id : "";
    const out: Record<string, unknown> = { reference: { id, type: "cc.Node" } };
    if (want("name") && typeof raw.name === "string") out.name = raw.name;
    if (want("active") && typeof raw.active === "boolean") out.active = raw.active;
    const components = Array.isArray(raw.components) ? raw.components : Array.isArray(raw.__comps__) ? raw.__comps__ : [];
    if (want("components")) out.components = components.slice(0, 100).flatMap((component): unknown[] => {
      if (!component || typeof component !== "object") return [];
      const value = "value" in component ? component.value : component;
      const componentId = value && typeof value === "object" && "uuid" in value
        ? (value.uuid && typeof value.uuid === "object" && "value" in value.uuid ? value.uuid.value : value.uuid)
        : undefined;
      const type = "type" in component && typeof component.type === "string" ? component.type : "cc.Component";
      return typeof componentId === "string" ? [{ reference: { id: componentId, type } }] : [];
    });
    const children = Array.isArray(raw.children) ? raw.children : [];
    const outputChildren: unknown[] = [];
    if (depth >= maxDepth && children.length > 0) {
      truncation ??= "maxDepth";
      out.childrenOmitted = children.length;
    } else {
      for (let index = 0; index < children.length; index += 1) {
        if (remaining <= 0) {
          truncation ??= "nodeLimit";
          out.childrenOmitted = children.length - index;
          break;
        }
        outputChildren.push(visit(children[index], depth + 1));
      }
    }
    out.children = outputChildren;
    return out;
  };
  const tree = visit(root, 0);
  return { tree, nodeCount, ...(truncation ? { truncated: truncation } : {}) };
}

function boundAssetTree(root: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const maxDepth = typeof args.maxDepth === "number" && Number.isInteger(args.maxDepth) ? Math.min(Math.max(args.maxDepth, 1), 99) : 4;
  const maxNodes = typeof args.maxNodes === "number" && Number.isInteger(args.maxNodes) ? Math.min(Math.max(args.maxNodes, 1), 10000) : 200;
  let remaining = maxNodes - 1;
  const visit = (node: Record<string, unknown>, depth: number): void => {
    const children = Array.isArray(node.children) ? node.children.filter((child): child is Record<string, unknown> => Boolean(child) && typeof child === "object" && !Array.isArray(child)) : [];
    node.childrenCount = children.length;
    if (depth >= maxDepth) {
      if (children.length > 0) {
        node.truncated = "maxDepth";
        node.childrenOmitted = children.length;
      }
      node.children = [];
      return;
    }
    const kept: Record<string, unknown>[] = [];
    for (let index = 0; index < children.length; index += 1) {
      if (remaining <= 0) {
        node.truncated = "nodeLimit";
        node.childrenOmitted = children.length - index;
        break;
      }
      remaining -= 1;
      visit(children[index], depth + 1);
      kept.push(children[index]);
    }
    node.children = kept;
  };
  visit(root, 0);
  return root;
}

async function setSiblingIndex(channel: CreatorChannel, uuid: string, parentUuid: string, index: number): Promise<void> {
  const parent = await channel("scene", "query-node", parentUuid);
  if (!parent || typeof parent !== "object" || !("children" in parent) || !Array.isArray(parent.children)) throw new Error(`Parent ${parentUuid} has no children.`);
  const currentIndex = parent.children.findIndex((child) => {
    if (!child || typeof child !== "object") return false;
    const value = "value" in child ? child.value : child;
    return value && typeof value === "object" && "uuid" in value && value.uuid === uuid;
  });
  if (currentIndex < 0 || index < 0 || index >= parent.children.length) throw new Error(`Sibling index ${index} is invalid for ${uuid}.`);
  const moved = await channel("scene", "move-array-element", { uuid: parentUuid, path: "children", target: currentIndex, offset: index - currentIndex });
  if (moved === false) throw new Error(`Creator refused sibling reorder for ${uuid}.`);
}
async function queryAssetsCompat(channel: CreatorChannel, query: Record<string, unknown>): Promise<unknown[]> {
  const pattern = typeof query.pattern === "string" && query.pattern ? query.pattern : "db://assets/**";
  const [objectResult, patternResult] = await Promise.allSettled([
    channel("asset-db", "query-assets", query),
    channel("asset-db", "query-assets", pattern),
  ]);
  const selected = objectResult.status === "fulfilled" && Array.isArray(objectResult.value)
    ? objectResult.value
    : patternResult.status === "fulfilled" && Array.isArray(patternResult.value)
      ? patternResult.value
      : undefined;
  if (!selected) throw new Error("Creator asset query is unavailable for both supported signatures.");
  return selected.filter((asset) => {
    if (!asset || typeof asset !== "object") return false;
    if (typeof query.ccType === "string" && (!("type" in asset) || asset.type !== query.ccType)) return false;
    if (typeof query.importer === "string" && (!("importer" in asset) || asset.importer !== query.importer)) return false;
    if (typeof query.extname === "string" && (!("url" in asset) || typeof asset.url !== "string" || !asset.url.endsWith(query.extname))) return false;
    if (typeof query.isBundle === "boolean" && (!("isBundle" in asset) || asset.isBundle !== query.isBundle)) return false;
    return true;
  });
}


async function assetQuery(channel: CreatorChannel, args: Record<string, unknown>): Promise<unknown> {
  switch (args.action) {
    case "at-path": {
      const info = await channel("asset-db", "query-asset-info", text(args.assetPath, "assetPath"));
      if (!info || typeof info !== "object" || !("uuid" in info)) throw new Error("Asset not found.");
      const type = "type" in info && typeof info.type === "string" ? info.type : "cc.Asset";
      return reference(info.uuid, type);
    }
    case "available-url":
      return { url: await channel("asset-db", "generate-available-url", text(args.assetPath, "assetPath")) };
    case "resolve": {
      const target = args.target ?? args.assetPath;
      const info = await channel("asset-db", "query-asset-info", target);
      if (!info) return { filesystemPath: "", exists: false };
      return info;
    }
    case "search": {
      const query = Object.fromEntries(Object.entries(args).filter(([key, value]) => !["action", "limit"].includes(key) && value !== undefined));
      const assets = await queryAssetsCompat(channel, query);
      const limit = listLimit(args.limit);
      return { assets: assets.slice(0, limit), total: assets.length, truncated: assets.length > limit };
    }

    case "tree": {
      let root = optionalText(args.assetPath, "assetPath");
      if (args.target !== undefined) {
        const info = await channel("asset-db", "query-asset-info", text(args.target, "asset target"));
        if (!info || typeof info !== "object" || !("url" in info) || typeof info.url !== "string") throw new Error("Asset tree root is unavailable.");
        root = info.url;
      }
      root ??= "db://assets";
      const [assets, rootUuid] = await Promise.all([
        queryAssetsCompat(channel, { pattern: `${root}/**` }),
        channel("asset-db", "query-uuid", root),
      ]);
      const byUrl = new Map<string, Record<string, unknown>>();
      const rootNode: Record<string, unknown> = { reference: { id: typeof rootUuid === "string" && rootUuid ? rootUuid : root, type: "folder" }, name: root.split("/").pop() || "assets", children: [] };
      byUrl.set(root, rootNode);
      for (const asset of assets) {
        if (!asset || typeof asset !== "object" || !("url" in asset) || typeof asset.url !== "string" || asset.url === root) continue;
        byUrl.set(asset.url, { reference: { id: "uuid" in asset ? asset.uuid : asset.url, type: "isDirectory" in asset && asset.isDirectory ? "folder" : "type" in asset ? asset.type : "cc.Asset" }, name: "name" in asset ? asset.name : asset.url.split("/").pop(), children: [] });
      }
      for (const [url, child] of byUrl) {
        if (url === root) continue;
        const parent = byUrl.get(url.slice(0, url.lastIndexOf("/")));
        if (parent && Array.isArray(parent.children)) parent.children.push(child);
      }
      return boundAssetTree(rootNode, args);
    }
    default:
      throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Unknown finite asset query action.", { action: String(args.action) });
  }
}

async function sceneReadNode(channel: CreatorChannel, args: Record<string, unknown>): Promise<unknown> {
  switch (args.action) {
    case "scene-info": {
      const [bounds, dirty, current] = await Promise.all([
        channel("scene", "query-scene-bounds"), channel("scene", "query-dirty"), channel("scene", "query-current-scene"),
      ]);
      return { bounds, dirty: Boolean(dirty), ...(current !== undefined ? { currentScene: typeof current === "string" ? { uuid: current } : current } : {}) };
    }
    case "by-asset": {
      const raw = await channel("scene", "query-nodes-by-asset-uuid", text(args.target, "asset reference"));
      const ids = Array.isArray(raw) ? raw : [];
      const limit = listLimit(args.limit);
      return { references: ids.slice(0, limit).map((id) => ({ id, type: "cc.Node" })), total: ids.length, truncated: ids.length > limit };
    }
    case "missing-assets": {
      const raw = await channel("scene", "query-nodes-miss-assets");
      if (!Array.isArray(raw)) throw new Error("Missing-assets query returned an invalid payload.");
      const limit = listLimit(args.limit);
      const references = raw.map((item) => typeof item === "string" ? { id: item, type: "cc.Node" } : item);
      return { references: references.slice(0, limit), total: references.length, truncated: references.length > limit };
    }
    case "tree": {
      const tree = await channel("scene", "query-node-tree", ...(args.target === undefined ? [] : [args.target]));
      return boundedSceneTree(tree, args);
    }
    case "at-path": {
      const tree = await channel("scene", "query-node-tree");
      const parts = text(args.hierarchyPath, "hierarchyPath").split("/").filter(Boolean);
      let current: unknown = tree;
      for (const part of parts) {
        if (!current || typeof current !== "object" || Array.isArray(current) || !("children" in current) || !Array.isArray(current.children)) return { references: [] };
        current = current.children.find((child) => child && typeof child === "object" && "name" in child && child.name === part);
      }
      if (!current || typeof current !== "object" || !("uuid" in current) || typeof current.uuid !== "string") return { references: [] };
      return { references: [{ id: current.uuid, type: "cc.Node" }] };
    }
    case "find": {
      const tree = await channel("scene", "query-node-tree");
      const name = typeof args.name === "string" ? args.name.toLowerCase() : undefined;
      const componentType = optionalText(args.componentType, "componentType");
      const max = listLimit(args.maxResults);
      const nodes: unknown[] = [];
      let total = 0;
      const walk = (node: unknown, path: string): void => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const nodeName = "name" in node && typeof node.name === "string" ? node.name : "";
        const components = "components" in node && Array.isArray(node.components) ? node.components : [];
        const nameOk = !name || nodeName.toLowerCase().includes(name);
        const componentOk = !componentType || components.some((component) => component && typeof component === "object" && "type" in component && component.type === componentType);
        if (nameOk && componentOk && "uuid" in node && typeof node.uuid === "string") {
          total += 1;
          if (nodes.length < max) nodes.push({ reference: { id: node.uuid, type: "cc.Node" }, name: nodeName, path });
        }
        if ("children" in node && Array.isArray(node.children)) for (const child of node.children) {
          const childName = child && typeof child === "object" && "name" in child && typeof child.name === "string" ? child.name : "";
          walk(child, path ? `${path}/${childName}` : childName);
        }
      };
      walk(tree, "");
      return { nodes, total, truncated: total > nodes.length };
    }
    default:
      throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Unknown finite scene read action.", { action: String(args.action) });
  }
}

export function createCreatorAdapters(channel: CreatorChannel, local?: CreatorLocalApis) {
  return async function invoke(command: PrimitiveCommand): Promise<unknown> {
    const args = command.args as Record<string, unknown>;
    switch (command.op) {
      case "scene.readNode": return sceneReadNode(channel, args);
      case "scene.readComponent": {
        if (args.action === "types") {
          const raw = await channel("scene", "query-components");
          if (!Array.isArray(raw)) throw new Error("Component type query returned an invalid payload.");
          const filtered = raw.filter((entry) => entry && typeof entry === "object"
            && (args.includeInternal || ("assetUuid" in entry && typeof entry.assetUuid === "string" && entry.assetUuid))
            && (!args.filter || ("type" in entry && typeof entry.type === "string" && entry.type.toLowerCase().includes(String(args.filter).toLowerCase()))));
          const names = filtered.map((entry) => "name" in entry ? entry.name : undefined).filter((name): name is string => typeof name === "string");
          const limit = listLimit(args.limit);
          return { componentTypes: names.slice(0, limit), total: names.length, truncated: names.length > limit };
        }
        return normalizeComponents(await channel("scene", "query-node", text(args.target, "node target")), args.componentType);
      }
      case "scene.createNode": {
        let parent = args.parent;
        if (parent === undefined) {
          const root = await channel("scene", "query-node-tree");
          if (!root || typeof root !== "object" || !("uuid" in root) || typeof root.uuid !== "string") throw new Error("Active scene root is unavailable.");
          parent = root.uuid;
        }
        let assetUuid: unknown = args.asset;
        if (args.prefab !== undefined) assetUuid = await channel("asset-db", "query-uuid", text(args.prefab, "prefab URL"));
        if (args.asset !== undefined) {
          const info = await channel("asset-db", "query-asset-info", text(args.asset, "asset"));
          if (!info || typeof info !== "object") throw new Error("Prefab asset is unavailable.");
          assetUuid = "uuid" in info ? info.uuid : args.asset;
        }
        const result = await channel("scene", "create-node", {
          name: text(args.name, "node name"),
          parent,
          ...(assetUuid !== undefined ? { assetUuid: text(assetUuid, "prefab asset UUID"), type: "cc.Prefab", unlinkPrefab: Boolean(args.unwrapPrefab) } : {}),
        });
        return creatorReference(result, "cc.Node");
      }
      case "scene.createPrimitive": {
        const prefabByPrimitive: Record<string, string> = {
          Capsule: "db://internal/default_file_content/3d/primitive/Capsule.prefab",
          Cone: "db://internal/default_file_content/3d/primitive/Cone.prefab",
          Cube: "db://internal/default_file_content/3d/primitive/Cube.prefab",
          Cylinder: "db://internal/default_file_content/3d/primitive/Cylinder.prefab",
          Plane: "db://internal/default_file_content/3d/primitive/Plane.prefab",
          Quad: "db://internal/default_file_content/3d/primitive/Quad.prefab",
          Sphere: "db://internal/default_file_content/3d/primitive/Sphere.prefab",
          Torus: "db://internal/default_file_content/3d/primitive/Torus.prefab",
        };
        const primitive = text(args.primitive, "primitive type");
        const prefabUrl = prefabByPrimitive[primitive];
        if (!prefabUrl) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Primitive type has no fixed Creator prefab.", { primitive });
        const assetUuid = await channel("asset-db", "query-uuid", prefabUrl);
        let parent = args.parent;
        if (parent === undefined) {
          const root = await channel("scene", "query-node-tree");
          if (!root || typeof root !== "object" || !("uuid" in root) || typeof root.uuid !== "string") throw new Error("Active scene root is unavailable.");
          parent = root.uuid;
        }
        const result = await channel("scene", "create-node", { name: args.name ?? primitive, parent, assetUuid, type: "cc.Prefab", unlinkPrefab: true });
        return creatorReference(result, "cc.Node");
      }
      case "scene.addComponent": {
        const target = text(args.target, "component node");
        const before = normalizeComponents(await channel("scene", "query-node", target), undefined).references;
        await channel("scene", "create-component", { uuid: target, component: text(args.componentType, "component type") });
        const after = normalizeComponents(await channel("scene", "query-node", target), undefined).references;
        const existing = new Set(before.map((entry) => entry.id));
        const created = after.find((entry) => !existing.has(entry.id));
        if (!created) throw new Error("Creator did not expose the created component UUID.");
        return { reference: created };
      }
      case "scene.removeComponent": {
        const ok = await channel("scene", "remove-component", { uuid: text(args.target, "component") });
        if (ok === false) throw new Error("Creator refused component removal.");
        return { success: true };
      }
      case "scene.setProperties": {
        const target = text(args.target, "property target");
        for (const value of args.values as Array<{ property: unknown; value: unknown }>) {
          const path = text(value.property, "property path");
          const dump = value.value && typeof value.value === "object" && !Array.isArray(value.value) && "value" in value.value && "type" in value.value
            ? value.value : { value: value.value };
          const ok = await channel("scene", "set-property", { uuid: target, path, dump });
          if (ok === false) throw new Error(`Creator refused set-property at ${path}.`);
        }
        return { success: true };
      }
      case "scene.reset": {
        const targets = args.targets as unknown[];
        const ok = args.action === "property"
          ? await channel("scene", "reset-property", { uuid: targets[0], path: args.propertyPath })
          : args.action === "component"
            ? await channel("scene", "reset-component", { uuid: targets[0] })
            : await channel("scene", "reset-node", { uuid: targets.length === 1 ? targets[0] : targets });
        if (ok === false) throw new Error(`Creator refused ${String(args.action)} reset.`);
        return { success: true };
      }
      case "scene.arrayElement": {
        const target = text(args.target, "array target");
        const ok = args.action === "remove"
          ? await channel("scene", "remove-array-element", { uuid: target, path: args.propertyPath, index: args.index })
          : await channel("scene", "move-array-element", { uuid: target, path: args.propertyPath, target: args.index, offset: Number(args.toIndex) - Number(args.index) });
        if (ok === false) throw new Error(`Creator refused array element ${String(args.action)}.`);
        return { success: true };
      }
      case "scene.clipboard": {
        const targets = args.targets as unknown[];
        if (args.action === "copy") return { success: true, references: (await channel("scene", "copy-node", targets) as unknown[]).map((id) => ({ id, type: "cc.Node" })) };
        if (args.action === "cut") { await channel("scene", "cut-node", targets); return { success: true, references: targets.map((id) => ({ id, type: "cc.Node" })) }; }
        const pasted = await channel("scene", "paste-node", { target: args.destination, uuids: targets, keepWorldTransform: args.keepWorldTransform ?? true, pasteAsChild: args.pasteAsChild ?? false });
        return { success: true, references: Array.isArray(pasted) ? pasted.map((id) => ({ id, type: "cc.Node" })) : [] };
      }
      case "scene.performanceSnapshot": {
        const tree = await channel("scene", "query-node-tree");
        if (!tree || typeof tree !== "object") throw new Error("No active scene is available.");
        let nodeCount = 0;
        let componentCount = 0;
        let uiNodeCount = 0;
        let activeNodes = 0;
        let maxDepth = 0;
        const walk = (node: unknown, depth: number): void => {
          if (!node || typeof node !== "object" || Array.isArray(node)) return;
          nodeCount += 1;
          maxDepth = Math.max(maxDepth, depth);
          if (!("active" in node) || node.active !== false) activeNodes += 1;
          const components = "__comps__" in node && Array.isArray(node.__comps__) ? node.__comps__
            : "components" in node && Array.isArray(node.components) ? node.components : [];
          componentCount += components.length;
          if ("layer" in node && node.layer === 33554432) uiNodeCount += 1;
          if ("children" in node && Array.isArray(node.children)) for (const child of node.children) walk(child, depth + 1);
        };
        walk(tree, 0);
        const warnings: string[] = [];
        if (nodeCount > 500) warnings.push(`High node count: ${nodeCount} nodes may impact performance`);
        if (maxDepth > 15) warnings.push(`Deep hierarchy: depth ${maxDepth} may cause layout issues`);
        if (componentCount > nodeCount * 3) warnings.push(`High component density: ${componentCount} components on ${nodeCount} nodes`);
        return { nodeCount, componentCount, uiNodeCount, maxDepth, activeNodes, warnings };
      }
      case "scene.lifecycle": {
        const action = text(args.action, "scene lifecycle action");
        const messages: Record<string, string> = { open: "open-scene", save: "save-scene", save_as: "save-as-scene", close: "close-scene", soft_reload: "soft-reload" };
        const result = await channel("scene", messages[action], ...(args.target === undefined ? [] : [args.target]));
        if (action === "save_as") return { success: true, reference: creatorReference(result, "cc.SceneAsset").reference };
        return { success: true, ...(args.target ? { reference: { id: args.target, type: "cc.SceneAsset" } } : {}) };
      }
      case "scene.operateNode": {
        const action = text(args.action, "node action");
        const target = text(args.target, "node target");
        if (action === "move") {
          const destination = text(args.destination, "node destination");
          await channel("scene", "set-parent", { parent: destination, uuids: target, keepWorldTransform: true });
          if (args.siblingIndex !== undefined) await setSiblingIndex(channel, target, destination, Number(args.siblingIndex));
          return { success: true };
        }
        if (action === "copy") {
          if (args.siblingIndex !== undefined && args.destination === undefined) {
            throw new CcpError("CCP_CONTRACT_MISMATCH", "Copy with siblingIndex requires a destination.");
          }
          const result = await channel("scene", "duplicate-node", [target]);
          const copied = creatorReference(result, "cc.Node");
          if (args.destination !== undefined) await channel("scene", "set-parent", { parent: args.destination, uuids: [copied.reference.id], keepWorldTransform: true });
          if (args.siblingIndex !== undefined) await setSiblingIndex(channel, copied.reference.id, text(args.destination, "node destination"), Number(args.siblingIndex));
          return { success: true, copiedNodeReference: copied.reference };
        }
        if (action === "delete") {
          await channel("scene", "remove-node", { uuid: target });
          const remaining = await channel("scene", "query-node", target);
          if (remaining !== null && remaining !== undefined) throw new Error(`Node ${target} still exists after removal.`);
          return { success: true };
        }
        if (action === "lock" || action === "unlock") {
          await channel("scene", "change-node-lock", target, action === "lock", Boolean(args.recursive));
          return { success: true };
        }
        if (action === "create_prefab") {
          const node = await channel("scene", "query-node", target);
          const current = await channel("scene", "query-current-scene");
          if (!node || typeof node !== "object") throw new Error(`Node ${target} was not found.`);
          const parentValue = "parent" in node && node.parent && typeof node.parent === "object" && "value" in node.parent ? node.parent.value : "parent" in node ? node.parent : undefined;
          const parentUuid = parentValue && typeof parentValue === "object" && "uuid" in parentValue && typeof parentValue.uuid === "string"
            ? parentValue.uuid
            : typeof current === "string" ? current : current && typeof current === "object" && "uuid" in current && typeof current.uuid === "string" ? current.uuid : undefined;
          if (!parentUuid) throw new Error(`Node ${target} has no observable parent.`);
          const before = await channel("scene", "query-node", parentUuid);
          if (!before || typeof before !== "object" || !("children" in before) || !Array.isArray(before.children)) throw new Error(`Parent ${parentUuid} has no children.`);
          const siblingIndex = before.children.findIndex((child) => {
            const value = child && typeof child === "object" && "value" in child ? child.value : child;
            return value && typeof value === "object" && "uuid" in value && value.uuid === target;
          });
          if (siblingIndex < 0) throw new Error(`Node ${target} is absent from parent ${parentUuid}.`);
          const created = creatorReference(await channel("scene", "execute-scene-script", {
            name: "ccp3x",
            method: "createPrefabFromNode",
            args: [target, text(args.prefabPath, "prefab path")],
          }), "cc.Prefab").reference;
          const after = await channel("scene", "query-node", parentUuid);
          if (!after || typeof after !== "object" || !("children" in after) || !Array.isArray(after.children) || !after.children[siblingIndex]) {
            throw new Error("Creator did not expose the replacement prefab node.");
          }
          const child = after.children[siblingIndex];
          const value = child && typeof child === "object" && "value" in child ? child.value : child;
          const updatedId = value && typeof value === "object" && "uuid" in value ? value.uuid : undefined;
          return { success: true, createdPrefabAssetReference: created, updatedNodeReference: { id: text(updatedId, "updated prefab node"), type: "cc.Node" } };
        }
        if (action === "link_prefab") {
          await channel("scene", "link-prefab", target, text(args.prefabAsset, "prefab asset"));
          return { success: true };
        }
        if (action === "revert_prefab") {
          const result = await channel("scene", "restore-prefab", { uuid: target });
          if (result !== true) throw new Error("Creator failed to restore the prefab.");
          return { success: true };
        }
        if (action === "apply_prefab" || action === "unwrap_prefab" || action === "unwrap_prefab_completely") {
          const result = await channel("scene", "execute-scene-script", {
            name: "ccp3x",
            method: action === "apply_prefab" ? "applyPrefabByNode" : "unlinkPrefabByNode",
            args: action === "apply_prefab" ? [target] : [target, action === "unwrap_prefab_completely"],
          });
          if (result !== null && result !== undefined) throw new Error(`Creator failed to ${action}.`);
          return { success: true };
        }
        if (action === "open_prefab") {
          const node = await channel("scene", "query-node", target);
          if (!node || typeof node !== "object") throw new Error(`Node ${target} is unavailable.`);
          const prefab = "__prefab__" in node ? node.__prefab__ : "_prefab" in node ? node._prefab : undefined;
          const value = prefab && typeof prefab === "object" && "value" in prefab ? prefab.value : prefab;
          const assetUuid = value && typeof value === "object" && "assetUuid" in value ? value.assetUuid : value && typeof value === "object" && "uuid" in value ? value.uuid : undefined;
          await channel("asset-db", "open-asset", text(assetUuid, "prefab asset UUID"));
          return { success: true };
        }
        throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Unknown finite scene node action.", { action });
      }
      case "asset.query": return assetQuery(channel, args);
      case "asset.operate": {
        const action = text(args.action, "asset action");
        const target = text(args.target, "asset target");
        const info = await channel("asset-db", "query-asset-info", target);
        if (!info || typeof info !== "object" || !("url" in info) || typeof info.url !== "string" || !info.url) {
          throw new Error(`Asset ${target} has no concrete db:// URL.`);
        }
        const result = action === "open"
          ? await channel("asset-db", "open-asset", target)
          : await channel("asset-db", `${action}-asset`, info.url, ...(args.destination === undefined ? [] : [args.destination]));
        const type = "type" in info && typeof info.type === "string" ? info.type : "cc.Asset";
        if (action === "move" || action === "copy") return creatorReference(result, type);
        return { reference: { id: target, type } };
      }
      case "material.query": {
        const messages: Record<string, string> = { effects: "query-all-effects", effect: "query-effect", material: "query-material", serialized_material: "query-serialized-material", render_pipeline: "query-render-pipeline", physics_material: "query-physics-material" };
        const value = await channel("scene", messages[args.operation as string], ...(args.operation === "effects" ? [] : [args.operation === "effect" ? args.effectName : args.target]));
        if (args.operation === "effects") {
          const items = Array.isArray(value) ? value : [];
          const limit = listLimit(args.limit);
          return { result: items.slice(0, limit), total: items.length, truncated: items.length > limit };
        }
        return { result: value ?? null };
      }
      case "project.readSetting": {
        const config = await channel("project", "query-config", "project");
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Project settings are unavailable.");
        const namespace = optionalText(args.namespace, "namespace");
        const key = optionalText(args.key, "key");
        if (namespace !== undefined) {
          if (!Object.prototype.hasOwnProperty.call(config, namespace)) throw new Error(`Unknown project settings namespace ${namespace}.`);
          const category = config[namespace as keyof typeof config];
          if (key === undefined) return { config: category };
          if (!category || typeof category !== "object" || Array.isArray(category) || !Object.prototype.hasOwnProperty.call(category, key)) throw new Error(`Unknown project settings key ${namespace}.${key}.`);
          return { config: category[key as keyof typeof category] };
        }
        const entries = Object.entries(config);
        const limit = listLimit(args.limit);
        return { config: Object.fromEntries(entries.slice(0, limit)), total: entries.length, truncated: entries.length > limit };
      }
      case "project.writeSetting": {
        const ok = await channel("project", "set-config", "project", text(args.path, "project setting path"), args.value);
        if (ok === false) throw new Error(`Creator refused project setting write at ${String(args.path)}.`);
        return { success: true };
      }
      case "editor.query": {
        const category = text(args.category, "editor query category");
        if (category === "script_info") {
          const target = text(args.target, "script target");
          const [scriptName, scriptCid] = await Promise.all([
            channel("scene", "query-script-name", target),
            channel("scene", "query-script-cid", target),
          ]);
          if (scriptName == null && scriptCid == null) throw new Error(`No script found for ${target}.`);
          return { ...(typeof scriptName === "string" ? { scriptName } : {}), ...(typeof scriptCid === "string" ? { scriptCid } : {}) };
        }
        const messages: Record<string, [string, string]> = { scene_mode: ["scene", "query-scene-mode"], ready: ["scene", "query-is-ready"], enum_values: ["scene", "query-enum-list-with-path"], layers: ["scene", "query-layer-builtin"], sorting_layers: ["scene", "query-sorting-layer-builtin"], has_script: ["scene", "query-component-has-script"], creatable_assets: ["scene", "query-creatable-asset-types"], asset_types: ["asset-db", "query-all-asset-types"], importers: ["asset-db", "query-all-importer"], shared_settings: ["programming", "query-shared-settings"], sorted_plugins: ["programming", "query-sorted-plugins"] };
        const tuple = messages[category];
        if (!tuple) throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Unknown finite editor query category.", { category });
        const [module, message] = tuple;
        const value = await channel(module, message, ...(args.enumPath !== undefined ? [args.enumPath] : args.className !== undefined ? [args.className] : args.target !== undefined ? [args.target] : []));
        if (category === "scene_mode") return { sceneMode: String(value) };
        if (category === "ready") return { ready: Boolean(value) };
        if (category === "has_script") return { hasScript: Boolean(value) };
        if (category === "shared_settings" || category === "sorted_plugins") return { result: value };
        if (category === "creatable_assets" || category === "asset_types" || category === "importers") {
          const items = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
          return { types: items.map((item) => typeof item === "string" ? item : item && typeof item === "object" && "name" in item ? item.name : item && typeof item === "object" && "type" in item ? item.type : undefined).filter((item): item is string => typeof item === "string") };
        }
        if (value === null || value === undefined) throw new Error(`Editor query ${category} returned no payload.`);
        const items = Array.isArray(value) ? value : typeof value === "object" ? Object.entries(value).map(([name, entry]) => ({ name, value: entry })) : [value];
        return { values: items.map((item) => item && typeof item === "object" ? { name: "name" in item ? item.name : "key" in item ? item.key : undefined, value: "value" in item ? item.value : undefined } : { name: String(item), value: item }) };
      }
      case "editor.selection": {
        if (!local) throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Fixed Editor selection adapter is unavailable.");
        const type = args.selectionType === "asset" ? "asset" : "node";
        const targets = Array.isArray(args.targets) ? args.targets.map((target) => text(target, "selection target")) : [];
        if (args.action === "select") local.selection.select(type, targets.length === 1 ? targets[0] : targets);
        else if (args.action === "unselect") local.selection.unselect(type, targets.length === 1 ? targets[0] : targets);
        else if (args.action === "clear") local.selection.clear(type);
        else if (args.action === "hover") local.selection.hover(type, targets[0]);
        else if (args.action === "update") local.selection.update(type, targets);
        else if (args.action === "select_all") await channel("scene", "select-all-nodes");
        else if (args.action !== "query") throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Unknown finite selection action.", { action: String(args.action) });
        return { success: true, selected: local.selection.getSelected(type), lastSelected: local.selection.getLastSelected(type) };
      }
      case "editor.viewport": {
        const action = text(args.action, "viewport action");
        const messages: Record<string, string> = { focus: "focus-camera", set_2d_mode: "change-is2D", set_grid_visible: "set-grid-visible", set_icon_gizmo_3d: "set-icon-gizmo-3d", set_icon_gizmo_size: "set-icon-gizmo-size", set_gizmo_tool: "change-gizmo-tool", set_gizmo_pivot: "change-gizmo-pivot", set_gizmo_coordinate: "change-gizmo-coordinate", align_view_to_selected_node: "align-view-with-node", align_selected_node_to_view: "align-with-view" };
        if (action === "query_gizmo") { const [gizmoTool, gizmoPivot, gizmoCoordinate] = await Promise.all([channel("scene", "query-gizmo-tool-name"), channel("scene", "query-gizmo-pivot"), channel("scene", "query-gizmo-coordinate")]); return { success: true, gizmoTool, gizmoPivot, gizmoCoordinate }; }
        if (action === "query_viewport") { const [is2D, gridVisible, iconGizmo3D, iconGizmoSize] = await Promise.all([channel("scene", "query-is2D"), channel("scene", "query-is-grid-visible"), channel("scene", "query-is-icon-gizmo-3d"), channel("scene", "query-icon-gizmo-size")]); return { success: true, is2D: Boolean(is2D), gridVisible: Boolean(gridVisible), iconGizmo3D: Boolean(iconGizmo3D), iconGizmoSize }; }
        const message = messages[action];
        if (!message) throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Unknown finite viewport action.", { action });
        if (action === "align_view_to_selected_node" || action === "align_selected_node_to_view") await channel("scene", message);
        else await channel("scene", message, args.targets ?? args.value);
        return { success: true };
      }
      case "editor.history": await channel("scene", args.action === "undo" ? "undo" : args.action === "redo" ? "redo" : "snapshot-abort"); return { success: true };
      case "animation.query": {
        const query = text(args.query, "animation query");
        const values = args.values as unknown[];
        const calls: Record<string, [string, unknown[]]> = {
          root_info: ["query-animation-root-info", [args.target]],
          root: ["query-animation-root", [args.target]],
          edit_info: ["query-animation-edit-info", [args.target]],
          clips_info: ["query-animation-clips-info", [args.target]],
          clip_dump: ["query-animation-clip", [args.target, args.clip]],
          properties: ["query-animation-properties", [args.target]],
          state: ["query-animation-state", []],
          current_info: ["query-current-animation-info", []],
          clip_time: ["query-animation-clips-time", [args.clip]],
          value_at_frame: ["query-property-value-at-frame", [args.clip, ...values]],
        };
        const tuple = calls[query];
        if (!tuple) throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Unknown finite animation query.", { query });
        return { result: (await channel("scene", tuple[0], ...tuple[1].filter((value) => value !== undefined))) ?? null };
      }
      case "animation.edit": {
        const action = text(args.action, "animation action");
        const values = args.values as unknown[];
        let message: string;
        let callArgs: unknown[];
        if (action === "record_start" || action === "record_stop") {
          message = "record-animation";
          callArgs = [args.target, action === "record_start", args.clip].filter((value) => value !== undefined);
        } else if (action === "change_root") {
          message = "change-animation-root";
          callArgs = [args.target, args.clip];
        } else if (action === "set_edit_clip") {
          message = "change-edit-clip";
          callArgs = [args.clip];
        } else if (action === "set_edit_time") {
          message = "set-edit-time";
          callArgs = [values[0]];
        } else if (action === "clip_state") {
          message = "change-clip-state";
          callArgs = [values[0], args.clip];
        } else if (action === "save_clip") {
          message = "save-clip";
          callArgs = [];
        } else {
          throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Unknown finite animation edit action.", { action });
        }
        const ok = await channel("scene", message, ...callArgs);
        if ((action === "record_start" || action === "record_stop" || action === "save_clip") && !ok) {
          throw new Error(`Creator failed animation action ${action}.`);
        }
        return { success: Boolean(ok) };
      }
      case "build.openPanel": await channel("builder", "open", args.panel); return { success: true };
      case "build.query": {
        if (args.query === "task") {
          const task = await channel("builder", "query-task", args.taskId);
          if (!task) throw new Error(`Build task ${String(args.taskId)} was not found.`);
          return { task: slimTask(task), ...(typeof task === "object" && "options" in task ? { options: task.options } : {}) };
        }
        const [workerReady, info] = await Promise.all([channel("builder", "query-worker-ready"), channel("builder", "query-tasks-info")]);
        const queue = info && typeof info === "object" && "queue" in info && info.queue && typeof info.queue === "object" ? info.queue : {};
        const tasks = Object.values(queue).map(slimTask);
        const limit = listLimit(args.limit);
        return { workerReady: Boolean(workerReady), free: Boolean(info && typeof info === "object" && "free" in info && info.free), tasks: tasks.slice(0, limit), total: tasks.length, truncated: tasks.length > limit };
      }
      case "build.start": {
        const result = await channel("builder", "add-task", args.options);
        const taskId = typeof result === "string" ? result : result && typeof result === "object" && "id" in result && typeof result.id === "string" ? result.id : undefined;
        if (!taskId) throw new Error("Builder did not return a task ID.");
        return { success: true, taskId };
      }
      case "build.control": {
        const ok = await channel("builder", `${args.action}-task`, args.taskId);
        if (ok === false) throw new Error(`Builder refused ${String(args.action)} for ${String(args.taskId)}.`);
        return { success: true };
      }
      case "runtime.control": {
        const methods: Record<string, string> = { pause: "runtimePause", resume: "runtimeResume", "set-time-scale": "runtimeSetTimeScale", "get-state": "runtimeGetState" };
        const result = await channel("scene", "execute-scene-script", { name: "ccp3x", method: methods[args.action as string], args: args.value === undefined ? [] : [args.value] });
        if (args.action !== "get-state") return { success: result === true, ...(args.action === "set-time-scale" ? { scale: args.value } : {}) };
        if (!result || typeof result !== "object" || Array.isArray(result)
          || !("paused" in result) || typeof result.paused !== "boolean"
          || !("timeScale" in result) || typeof result.timeScale !== "number"
          || !("frameCount" in result) || typeof result.frameCount !== "number") {
          throw new Error("Creator returned malformed runtime state.");
        }
        return { paused: result.paused, timeScale: result.timeScale, frameCount: result.frameCount };
      }
      case "runtime.simulateButtonClick": {
        const target = text(args.target, "button node");
        const node = await channel("scene", "query-node", target);
        if (!node || typeof node !== "object") throw new Error(`Button node ${target} was not found.`);
        const result = await channel("scene", "execute-scene-script", { name: "ccp3x", method: "simulateButtonClick", args: [target] });
        if (!result || typeof result !== "object" || !("handlersFired" in result) || typeof result.handlersFired !== "number") throw new Error("Button simulation returned an invalid result.");
        return { handlersFired: result.handlersFired, method: "method" in result && typeof result.method === "string" ? result.method : "clickEvents" };
      }
      default: {
        const exhaustive: never = command;
        throw new CcpError("CCP_PRIMITIVE_UNKNOWN", "Relay has no adapter for this primitive.", { op: String(exhaustive) });
      }
    }
  };
}
