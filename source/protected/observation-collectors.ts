import { createHash } from "crypto";
import { assertIJson, canonicalizeToBytes, IJson } from "./canonical-json";
import { CcpError } from "./errors";
import { OBSERVATION_MAX_BYTES } from "./protocol";
import type { ProtectedObservation } from "./request-builder";

export interface ObservationSpec {
  contractId: string;
  consentVersion: string;
  fields: readonly string[];
}

export interface ObservationSelection {
  getSelected(type: "node" | "asset"): string[];
  getLastSelected(type: "node" | "asset"): string | undefined;
}

export interface ObservationRuntime {
  request(module: string, message: string, ...args: unknown[]): Promise<unknown>;
  selection?: ObservationSelection;
}

function jsonValue(value: unknown, depth = 0): IJson {
  if (depth > 64) throw new CcpError("CCP_LIMIT_EXCEEDED", "Creator observation exceeds the maximum nesting depth.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CcpError("CCP_CANONICAL_INVALID", "Creator observation contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, IJson> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined && typeof child !== "function" && typeof child !== "symbol") {
        Object.defineProperty(out, key, { value: jsonValue(child, depth + 1), enumerable: true, configurable: true, writable: true });
      }
    }
    return out;
  }
  throw new CcpError("CCP_CANONICAL_INVALID", "Creator observation contains a non-JSON value.");
}

function inputRecord(inputs: IJson): Record<string, IJson> {
  return inputs && typeof inputs === "object" && !Array.isArray(inputs) ? inputs : {};
}

function referenceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("id" in value)) return undefined;
  return typeof value.id === "string" && value.id ? value.id : undefined;
}

function collectReferenceIds(inputs: IJson): string[] {
  const record = inputRecord(inputs);
  const ids = new Set<string>();
  const singular = [
    "reference", "parentReference", "newParentReference", "prefabAssetReference",
    "targetReference", "nodeReference", "clipReference",
  ];
  for (const key of singular) {
    const id = referenceId(record[key]);
    if (id) ids.add(id);
  }
  const references = record.references;
  if (Array.isArray(references)) for (const value of references) {
    const id = referenceId(value);
    if (id) ids.add(id);
  }
  const entries = record.entries;
  if (Array.isArray(entries)) for (const value of entries) {
    if (value && typeof value === "object" && !Array.isArray(value) && "reference" in value) {
      const id = referenceId(value.reference);
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

async function inspectEntity(runtime: ObservationRuntime, id: string): Promise<IJson> {
  const node = await runtime.request("scene", "query-node", id);
  if (node !== null && node !== undefined) return { id, kind: "node", value: jsonValue(node) };
  const component = await runtime.request("scene", "query-component", id);
  if (component !== null && component !== undefined) return { id, kind: "component", value: jsonValue(component) };
  const asset = await runtime.request("asset-db", "query-asset-info", id);
  if (asset !== null && asset !== undefined) return { id, kind: "asset", value: jsonValue(asset) };
  throw new CcpError("CCP_PRECONDITION_FAILED", "Creator observation target no longer exists.", { target: id });
}

function projectValue(root: unknown, dotPath: string): unknown {
  let current = root;
  for (const segment of dotPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return null;
    current = current[segment as keyof typeof current];
  }
  return current;
}

async function collectProjection(contractId: string, inputs: IJson, runtime: ObservationRuntime): Promise<Record<string, IJson>> {
  const record = inputRecord(inputs);
  switch (contractId) {
    case "none-v1":
      return {};
    case "ui-parent-v1": {
      const root = await runtime.request("scene", "query-node-tree");
      if (!root) throw new CcpError("CCP_PRECONDITION_FAILED", "No active scene root is available.");
      const parentId = referenceId(record.parentReference);
      const parent = parentId ? await inspectEntity(runtime, parentId) : null;
      return { parentReference: parent, sceneRoot: jsonValue(root) };
    }
    case "scene-root-v1": {
      const [scene, root] = await Promise.all([
        runtime.request("scene", "query-current-scene"),
        runtime.request("scene", "query-node-tree"),
      ]);
      if (!root) throw new CcpError("CCP_PRECONDITION_FAILED", "No active scene root is available.");
      return { scene: jsonValue(scene ?? null), root: jsonValue(root) };
    }
    case "scene-target-v1": {
      const ids = collectReferenceIds(inputs);
      if (ids.length === 0) throw new CcpError("CCP_PRECONDITION_FAILED", "Scene target observation has no concrete references.");
      const targets = await Promise.all(ids.map((id) => inspectEntity(runtime, id)));
      return { targets };
    }
    case "scene-lifecycle-v1": {
      const [current, dirty] = await Promise.all([
        runtime.request("scene", "query-current-scene"),
        runtime.request("scene", "query-dirty"),
      ]);
      return { sceneLifecycle: { current: jsonValue(current ?? null), dirty: Boolean(dirty) } };
    }
    case "editor-history-v1": {
      const [current, dirty] = await Promise.all([
        runtime.request("scene", "query-current-scene"),
        runtime.request("scene", "query-dirty"),
      ]);
      return { history: { current: jsonValue(current ?? null), dirty: Boolean(dirty) } };
    }
    case "editor-state-v1": {
      if (!runtime.selection) throw new CcpError("CCP_PRECONDITION_FAILED", "Editor selection state is unavailable.");
      const [is2D, gridVisible, gizmoTool, gizmoPivot, gizmoCoordinate] = await Promise.all([
        runtime.request("scene", "query-is2D"),
        runtime.request("scene", "query-is-grid-visible"),
        runtime.request("scene", "query-gizmo-tool-name"),
        runtime.request("scene", "query-gizmo-pivot"),
        runtime.request("scene", "query-gizmo-coordinate"),
      ]);
      return { editorState: {
        selectedNodes: [...runtime.selection.getSelected("node")],
        selectedAssets: [...runtime.selection.getSelected("asset")],
        lastNode: runtime.selection.getLastSelected("node") ?? null,
        lastAsset: runtime.selection.getLastSelected("asset") ?? null,
        is2D: Boolean(is2D), gridVisible: Boolean(gridVisible),
        gizmoTool: jsonValue(gizmoTool ?? null), gizmoPivot: jsonValue(gizmoPivot ?? null), gizmoCoordinate: jsonValue(gizmoCoordinate ?? null),
      } };
    }
    case "animation-target-v1": {
      const state = await runtime.request("scene", "query-animation-state");
      const ids = collectReferenceIds(inputs);
      const targets = await Promise.all(ids.map((id) => inspectEntity(runtime, id)));
      return { animationTarget: { state: jsonValue(state ?? null), targets } };
    }
    case "build-task-v1": {
      const taskId = typeof record.taskId === "string" ? record.taskId : undefined;
      const task = taskId
        ? await runtime.request("builder", "query-task", taskId)
        : await runtime.request("builder", "query-tasks-info");
      return { buildTask: jsonValue(task ?? null) };
    }
    case "runtime-state-v1": {
      const state = await runtime.request("scene", "execute-scene-script", { name: "ccp3x", method: "runtimeGetState", args: [] });
      if (!state || typeof state !== "object") throw new CcpError("CCP_PRECONDITION_FAILED", "Runtime state is unavailable.");
      return { runtimeState: jsonValue(state) };
    }
    case "project-setting-v1": {
      const config = await runtime.request("project", "query-config", "project");
      if (config === undefined || config === null) throw new CcpError("CCP_PRECONDITION_FAILED", "Project settings are unavailable.");
      const path = typeof record.path === "string" ? record.path : typeof record.key === "string" ? record.key : "";
      return { projectSetting: { path, value: jsonValue(path ? projectValue(config, path) : config) } };
    }
    default:
      throw new CcpError("CCP_CONTRACT_MISMATCH", "Unknown canonical observation contract.", { contractId });
  }
}

export async function collectObservation(spec: ObservationSpec, inputs: IJson, runtime: ObservationRuntime): Promise<ProtectedObservation> {
  for (const field of spec.fields) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
      throw new CcpError("CCP_CONTRACT_MISMATCH", "Observation field is not a public contract identifier.", { field });
    }
  }
  const projection = await collectProjection(spec.contractId, inputs, runtime);
  const fields: Record<string, IJson> = {};
  for (const field of spec.fields) {
    if (!Object.prototype.hasOwnProperty.call(projection, field)) {
      throw new CcpError("CCP_CONTRACT_MISMATCH", "Observation field has no finite Creator projection.", { field, contractId: spec.contractId });
    }
    fields[field] = projection[field];
  }
  assertIJson(fields);
  const digest = createHash("sha256").update(canonicalizeToBytes(fields)).digest("hex");
  const observation: ProtectedObservation = {
    contractId: spec.contractId,
    consentVersion: spec.consentVersion,
    revisionToken: digest,
    digest,
    fields,
  };
  const bytes = canonicalizeToBytes(observation);
  if (bytes.byteLength > OBSERVATION_MAX_BYTES) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", "Observation exceeds the public contract byte cap.", { bytes: bytes.byteLength });
  }
  return observation;
}

export async function recheckObservation(
  spec: ObservationSpec,
  inputs: IJson,
  original: ProtectedObservation,
  runtime: ObservationRuntime,
): Promise<void> {
  const current = await collectObservation(spec, inputs, runtime);
  if (current.contractId !== original.contractId || current.consentVersion !== original.consentVersion
    || current.revisionToken !== original.revisionToken || current.digest !== original.digest) {
    throw new CcpError("CCP_PRECONDITION_FAILED", "Creator state changed after Gateway authorization.", {
      contractId: spec.contractId,
      expectedDigest: original.digest,
      actualDigest: current.digest,
    });
  }
}
