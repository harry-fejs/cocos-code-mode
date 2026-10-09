import { CcpError } from "./errors.ts";
import type { ProtectedRequest } from "./protocol.ts";
import type { SignedMetadata } from "./release-metadata.ts";
import type { CcBridgeStore } from "./store.ts";
import { PUBLIC_TOOL_BY_NAME } from "./tool-catalog.ts";

export interface SignedExecutionControls {
  policySequence: number;
  emergencyStop: boolean;
  disabledOperations: readonly string[];
}

export function persistSignedExecutionControls(store: CcBridgeStore, controls: SignedExecutionControls, wrapper: SignedMetadata): void {
  const saved = store.db.prepare(`UPDATE rollout_policy SET emergency_stop = ?, disabled_operations_json = ?, signed_wrapper_json = ? WHERE sequence = ?`)
    .run(controls.emergencyStop ? 1 : 0, JSON.stringify(controls.disabledOperations), JSON.stringify(wrapper), controls.policySequence);
  if (saved.changes !== 1) throw new CcpError("CCP_INTERNAL", "Signed execution policy could not be persisted.");
}

/**
 * The signed request has no trustworthy channel claim. Each channel's newest
 * policy for the request's exact imported package therefore applies, with deny
 * winning across channels. Ring/percentage affect update selection, not safety.
 * A different target or channel cannot clear a stop. Expiry never re-enables a
 * stopped tool: publish a newer signed policy for the same channel AND target
 * with the restriction removed. This is deliberately fail-closed after expiry.
 * Pre-v5 records have no recoverable signed controls; re-import signed policy
 * to establish enforcement for those historical policies.
 */
export function assertSignedExecutionAllowed(store: CcBridgeStore, request: ProtectedRequest): void {
  const policies = store.db.prepare(`
    SELECT policy.channel, policy.sequence, policy.emergency_stop, policy.disabled_operations_json
    FROM rollout_policy AS policy
    JOIN release_target AS target ON target.target_payload_hash = policy.target_hash
    WHERE target.package_hash = ? AND policy.sequence = (
      SELECT MAX(candidate.sequence) FROM rollout_policy AS candidate
      WHERE candidate.target_hash = policy.target_hash AND candidate.channel = policy.channel
    )
    ORDER BY policy.sequence DESC
  `).all(request.relay.packageHash) as Array<{
    channel: string; sequence: number; emergency_stop: number; disabled_operations_json: string;
  }>;
  const inputs = request.inputs;
  let operation = inputs && typeof inputs === "object" && !Array.isArray(inputs) && typeof inputs.operation === "string"
    ? inputs.operation : "*";
  if (operation === "*") {
    const properties = PUBLIC_TOOL_BY_NAME[request.tool.id]?.inputSchema.properties;
    const selector = properties && typeof properties === "object" && !Array.isArray(properties) && "operation" in properties
      ? properties.operation : undefined;
    if (selector && typeof selector === "object" && !Array.isArray(selector) && "default" in selector && typeof selector.default === "string") operation = selector.default;
  }
  for (const policy of policies) {
    const details = { channel: policy.channel, policySequence: policy.sequence, tool: request.tool.id };
    const recovery = "Ask a release administrator to publish a newer signed policy for the same channel and target clearing this restriction.";
    if (policy.emergency_stop) throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "A signed release policy emergency stop is active for this package.", details, recovery);
    let disabled: unknown;
    try { disabled = JSON.parse(policy.disabled_operations_json); }
    catch { throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Stored signed execution policy is unreadable."); }
    if (!Array.isArray(disabled) || disabled.length > 1024 || disabled.some((value) => typeof value !== "string" || value.length > 128)) {
      throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Stored signed execution policy is invalid.");
    }
    // Bare tool IDs disable the whole tool; tool:operation selects a finite
    // operation branch, and tool:* explicitly disables every branch.
    if (disabled.includes(request.tool.id) || disabled.includes(`${request.tool.id}:*`) || disabled.includes(`${request.tool.id}:${operation}`)) {
      throw new CcpError("CCP_CONTRACT_MISMATCH", "A signed release policy disables this protected operation.", details, recovery);
    }
  }
}
