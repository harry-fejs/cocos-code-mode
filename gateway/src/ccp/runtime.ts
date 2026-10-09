import { createPrivateKey } from "node:crypto";
import { CcpError } from "./errors.ts";
import { MemoryEnvelopeSigner, type EnvelopeSigner } from "./envelope-signer.ts";
import { ExecuteDependencies } from "./execute-service.ts";
import { planControlTool } from "./planners/plan-control-tools.ts";
import { planCreateTool } from "./planners/plan-create-tools.ts";
import { planMutationTool } from "./planners/plan-mutation-tools.ts";
import { planReadTool } from "./planners/plan-read-tools.ts";
import { ProtectedToolRegistry } from "./protected-tool-registry.ts";
import { ReplayStore } from "./replay-store.ts";
import { CcBridgeStore } from "./store.ts";
import { UnixSocketSigner } from "./unix-socket-signer.ts";
import { retainAdminMetadata } from "./admin-audit.ts";

class UnavailableSigner implements EnvelopeSigner {
  readonly keyId = "unavailable";
  async sign(): Promise<Buffer> {
    throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Execution signer is not configured.");
  }
}

export function createSigner(): EnvelopeSigner {
  const keyId = process.env.CCP_EXECUTION_KEY_ID;
  const socketPath = process.env.CCP_SIGNER_SOCKET;
  if (keyId && socketPath) return new UnixSocketSigner(keyId, socketPath);
  const pkcs8 = process.env.CCP_EXECUTION_PRIVATE_KEY_PKCS8;
  if (process.env.CCP_ALLOW_MEMORY_SIGNER === "1" && keyId && pkcs8) {
    return new MemoryEnvelopeSigner(
      keyId,
      createPrivateKey({ key: Buffer.from(pkcs8, "base64url"), format: "der", type: "pkcs8" }),
    );
  }
  return new UnavailableSigner();
}

export function registerCatalogPlanners(planners: ProtectedToolRegistry): void {
  planners.register("assetGetTree", 1, planReadTool);
  planners.register("assetGetAtPath", 1, planReadTool);
  planners.register("assetResolvePath", 1, planReadTool);
  planners.register("assetQuery", 1, planReadTool);
  planners.register("assetGetAvailableUrl", 1, planReadTool);
  planners.register("nodeGetAvailableComponentTypes", 1, planReadTool);
  planners.register("nodeComponentsGet", 1, planReadTool);
  planners.register("sceneGetInfo", 1, planReadTool);
  planners.register("findNodesByAsset", 1, planReadTool);
  planners.register("findNodesWithMissingAssets", 1, planReadTool);
  planners.register("findNodes", 1, planReadTool);
  planners.register("nodeGetTree", 1, planReadTool);
  planners.register("nodeGetAtPath", 1, planReadTool);
  planners.register("animationQuery", 1, planReadTool);
  planners.register("materialQuery", 1, planReadTool);
  planners.register("editorQuery", 1, planReadTool);
  planners.register("assetBatchQuery", 1, planReadTool);
  planners.register("getPerformanceSnapshot", 1, planReadTool);

  planners.register("createUiNode", 1, planCreateTool);
  planners.register("nodeCreate", 1, planCreateTool);
  planners.register("createLabel", 1, planCreateTool);
  planners.register("createButton", 1, planCreateTool);
  planners.register("createSprite", 1, planCreateTool);
  planners.register("nodeCreatePrimitive", 1, planCreateTool);

  planners.register("nodeOperate", 1, planMutationTool);
  planners.register("nodeReset", 1, planMutationTool);
  planners.register("inspectorSet", 1, planMutationTool);
  planners.register("nodeBatchSet", 1, planMutationTool);
  planners.register("nodeComponentManage", 1, planMutationTool);
  planners.register("projectManage", 1, planMutationTool);
  planners.register("animationEdit", 2, planMutationTool);
  planners.register("propertyArrayElement", 1, planMutationTool);
  planners.register("nodeClipboard", 1, planMutationTool);
  planners.register("sceneManage", 1, planMutationTool);

  planners.register("runtimePause", 1, planControlTool);
  planners.register("runtimeResume", 1, planControlTool);
  planners.register("runtimeSetTimeScale", 1, planControlTool);
  planners.register("runtimeGetState", 1, planControlTool);
  planners.register("editorHistory", 1, planControlTool);
  planners.register("editorSelect", 1, planControlTool);
  planners.register("editorViewport", 1, planControlTool);
  planners.register("buildManage", 1, planControlTool);
  planners.register("simulateButtonClick", 1, planControlTool);
}

export function createCcBridgeRuntime(): ExecuteDependencies {
  const store = new CcBridgeStore();
  retainAdminMetadata(store);
  const planners = new ProtectedToolRegistry();
  registerCatalogPlanners(planners);
  return {
    store,
    replay: new ReplayStore(store.db),
    signer: createSigner(),
    planners,
  };
}
