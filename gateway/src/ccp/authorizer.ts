import type { AuthContext } from "../auth.ts";
import { CcpError } from "./errors.ts";
import type { ProtectedRequest } from "./protocol.ts";
import type { CcBridgeStore, DeviceRecord, OperationClass, OperationPolicyRecord } from "./store.ts";
import { TOOL_CLASS } from "./tool-catalog.ts";

export interface Authorization {
  operationClass: OperationClass;
  policy: OperationPolicyRecord;
}


function versionTuple(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return undefined;
  const version: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return version.every(Number.isSafeInteger) ? version : undefined;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function versionSatisfies(versionText: string, range: string): boolean {
  const version = versionTuple(versionText);
  if (!version) return false;
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const match = /^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/.exec(clause);
    if (!match) return false;
    const bound = versionTuple(match[2]);
    if (!bound) return false;
    const cmp = compareVersion(version, bound);
    switch (match[1] ?? "=") {
      case ">=": return cmp >= 0;
      case ">": return cmp > 0;
      case "<=": return cmp <= 0;
      case "<": return cmp < 0;
      default: return cmp === 0;
    }
  });
}

export function authorizeProtectedRequest(
  store: CcBridgeStore,
  auth: AuthContext,
  device: DeviceRecord,
  request: ProtectedRequest,
  nowMs = Date.now(),
): Authorization {
  if (device.memberId !== auth.member_id) {
    throw new CcpError("CCP_DEVICE_DENIED", "Device is not bound to this member.");
  }
  const project = store.getProject(request.projectId);
  if (!project || project.status !== "active") {
    throw new CcpError("CCP_PROJECT_DENIED", "Project is unknown or disabled.");
  }
  const policy = store.getOperationPolicy(request.tool.id, request.tool.contractVersion);
  if (!policy || !policy.enabled) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Tool contract is disabled or unregistered.");
  }
  if (policy.contractHash !== request.tool.contractHash) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Tool contract hash does not match the registered policy.");
  }
  if (policy.blockedRelayBuilds.includes(request.relay.build)) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Relay build is blocked.");
  }
  if (policy.minimumRelayBuild && !versionSatisfies(request.relay.build, `>=${policy.minimumRelayBuild}`)) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Relay build is below the minimum permitted version.");
  }
  if (!versionSatisfies(request.relay.creatorVersion, policy.creatorRange)) {
    throw new CcpError("CCP_CREATOR_INCOMPATIBLE", "Creator version is outside the permitted range.");
  }
  if (policy.requiredConsentVersion && request.observation?.consentVersion !== policy.requiredConsentVersion) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Observation consent version does not match policy.");
  }
  const operationClass = TOOL_CLASS[request.tool.id];
  if (!operationClass) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Tool is not registered for protected execution.");
  }
  const grants = store.findActiveGrants({
    memberId: auth.member_id,
    deviceId: device.id,
    projectId: request.projectId,
    toolId: request.tool.id,
    operationClass,
    nowMs,
  });
  if (grants.length === 0) {
    throw new CcpError("CCP_PROJECT_DENIED", "No active grant covers this member, device, project, and tool.");
  }
  return { operationClass, policy };
}
