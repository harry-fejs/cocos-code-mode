import { CcpError } from "./errors.ts";
import type { GatewayDecision, ProtectedRequest } from "./protocol.ts";
import type { OperationPolicyRecord } from "./store.ts";
import { PUBLIC_TOOL_BY_NAME } from "./tool-catalog.ts";

export interface PlannerContext {
  request: ProtectedRequest;
  policy: OperationPolicyRecord;
  correlationId: string;
  nowMs: number;
}

export type ProtectedPlanner = (context: PlannerContext) => GatewayDecision;

export class ProtectedToolRegistry {
  private readonly planners = new Map<string, ProtectedPlanner>();

  register(toolId: string, contractVersion: number, planner: ProtectedPlanner): void {
    const contract = PUBLIC_TOOL_BY_NAME[toolId];
    if (!contract || contract.contractVersion !== contractVersion) {
      throw new Error(`protected planner is not canonical: ${toolId}@${contractVersion}`);
    }
    const key = `${toolId}@${contractVersion}`;
    if (this.planners.has(key)) throw new Error(`duplicate protected planner: ${key}`);
    this.planners.set(key, planner);
  }

  has(toolId: string, contractVersion = 1): boolean {
    return this.planners.has(`${toolId}@${contractVersion}`);
  }

  plan(context: PlannerContext): GatewayDecision {
    const planner = this.planners.get(`${context.request.tool.id}@${context.request.tool.contractVersion}`);
    if (!planner) {
      throw new CcpError("CCP_CONTRACT_MISMATCH", "No protected planner is registered for this tool contract.");
    }
    return planner(context);
  }
}
