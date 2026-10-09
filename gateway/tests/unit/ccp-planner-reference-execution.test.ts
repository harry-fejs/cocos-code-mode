import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCreatorAdapters } from "../../../source/protected/creator-adapters.ts";
import { executeEnvelope } from "../../../source/protected/primitive-executor.ts";
import type { IJson } from "../../src/ccp/canonical-json.ts";
import type { ProtectedRequest } from "../../src/ccp/protocol.ts";
import { filterProtectedInputs } from "../../src/ccp/input-filter.ts";
import { validateGatewayDecision } from "../../src/ccp/plan-validator.ts";
import { ProtectedToolRegistry, type PlannerContext } from "../../src/ccp/protected-tool-registry.ts";
import { registerCatalogPlanners } from "../../src/ccp/runtime.ts";
import { PUBLIC_TOOL_MANIFEST } from "../../src/ccp/tool-catalog.ts";

function planned(registry: ProtectedToolRegistry, name: string, inputs: IJson, fields: IJson) {
  const contract = PUBLIC_TOOL_MANIFEST.tools.find((entry) => entry.name === name)!;
  const observation = contract.operations["*"].observation;
  const request: ProtectedRequest = {
    protocolVersion: 1, requestId: randomUUID(), idempotencyKey: "abcdefghijklmnop",
    deviceId: randomUUID(), projectId: randomUUID(), relayInstanceId: randomUUID(),
    sequence: 1, issuedAtMs: Date.now(), nonce: "abcdefghijklmnopqrstuv",
    relay: { build: "2.0.0", packageHash: "b".repeat(64), creatorVersion: "3.8.7", os: "win32" },
    tool: { id: name, contractVersion: contract.contractVersion, contractHash: contract.contractHash },
    inputs,
    ...(observation.contractId === "none-v1" ? {} : {
      observation: { contractId: observation.contractId, consentVersion: observation.consentVersion,
        revisionToken: "revision-1", digest: "a".repeat(64), fields },
    }),
  };
  const context: PlannerContext = {
    request, correlationId: randomUUID(), nowMs: request.issuedAtMs,
    policy: { toolId: name, contractVersion: contract.contractVersion, enabled: true,
      contractHash: contract.contractHash, minimumRelayBuild: contract.minimumRelayBuild,
      blockedRelayBuilds: [], creatorRange: contract.creatorRange,
      requiredConsentVersion: observation.consentVersion, revision: 1 },
  };
  filterProtectedInputs(request);
  const decision = validateGatewayDecision(registry.plan(context), request);
  if (decision.kind !== "execute") throw new Error("Expected executable decision");
  return { request, envelope: decision.envelope };
}

const createPayload = z.object({ parent: z.string(), name: z.string() }).strict();
const propertyPayload = z.object({ uuid: z.string(), path: z.literal("name"), dump: z.object({ value: z.string() }).strict() }).strict();

it("executes an explicit-parent create and ten ordered name changes through real planners, resolver and Creator adapters", async () => {
  const registry = new ProtectedToolRegistry();
  registerCatalogPlanners(registry);
  const entities = new Map<string, { parent: string | null; name: string }>([
    ["root-real", { parent: null, name: "Root" }],
    ["selected-parent", { parent: "root-real", name: "Selected parent" }],
  ]);
  const changedNames: string[] = [];
  const snapshots: Array<Array<[string, { parent: string | null; name: string }]>> = [];
  let ipc = 0;
  const channel = async (module: string, message: string, ...args: unknown[]) => {
    ipc++;
    if (module !== "scene") throw new Error(`Unexpected channel ${module}`);
    if (message === "create-node") {
      const payload = createPayload.parse(args[0]);
      if (!entities.has(payload.parent)) throw new Error("Unknown parent");
      entities.set("created-child", { parent: payload.parent, name: payload.name });
      return "created-child";
    }
    if (message === "set-property") {
      const payload = propertyPayload.parse(args[0]);
      const entity = entities.get(payload.uuid);
      if (!entity) throw new Error("Unknown node");
      entity.name = payload.dump.value;
      changedNames.push(entity.name);
      return true;
    }
    if (message === "snapshot") {
      snapshots.push(structuredClone([...entities.entries()]));
      return true;
    }
    throw new Error(`Unexpected Creator message ${message}`);
  };
  const adapters = {
    invoke: createCreatorAdapters(channel), readIpcCount: () => ipc,
    snapshot: async () => { await channel("scene", "snapshot"); },
    recheckPreconditions: async () => {
      if (!entities.has("selected-parent")) throw new Error("Parent disappeared");
    },
  };
  const create = planned(registry, "nodeCreate", {
    name: "Initial", parentReference: { id: "selected-parent", type: "cc.Node" },
  }, { scene: { id: "scene-real" }, root: { id: "root-real" } });
  const created = await executeEnvelope(create.envelope, adapters, create.request);
  expect(entities.get("created-child")).toEqual({ parent: "selected-parent", name: "Initial" });
  expect(created.handles.get("node")?.id).toBe("created-child");
  expect(snapshots).toEqual([[...entities.entries()]]);

  const expectedNames = Array.from({ length: 10 }, (_, index) => `Step ${index + 1}`);
  const batch = planned(registry, "nodeBatchSet", {
    entries: expectedNames.map((name) => ({ reference: { id: "created-child", type: "cc.Node" }, propertyPaths: ["name"], values: [name] })),
  }, { targets: [{ id: "created-child", name: "Initial" }] });
  const beforeIpc = ipc;
  const execution = await executeEnvelope(batch.envelope, adapters, batch.request);
  expect(changedNames).toEqual(expectedNames);
  expect(entities.get("created-child")).toEqual({ parent: "selected-parent", name: "Step 10" });
  expect(snapshots).toHaveLength(2);
  expect(new Map(snapshots[1]).get("created-child")?.name).toBe("Step 10");
  expect(ipc - beforeIpc).toBe(11);
  expect(execution.snapshotTaken).toBe(true);
});

it("executes a targeted node tree read with the concrete reference ID", async () => {
  const registry = new ProtectedToolRegistry();
  registerCatalogPlanners(registry);
  let ipc = 0;
  const channel = async (module: string, message: string, ...args: unknown[]) => {
    ipc++;
    expect(module).toBe("scene");
    expect(message).toBe("query-node-tree");
    expect(args[0]).toBe("selected-node");
    return { uuid: "selected-node", name: "Selected", active: true, children: [] };
  };
  const read = planned(registry, "nodeGetTree", {
    reference: { id: "selected-node", type: "cc.Node" }, maxDepth: 0, maxNodes: 1,
  }, {});
  const execution = await executeEnvelope(read.envelope, {
    invoke: createCreatorAdapters(channel), readIpcCount: () => ipc,
    snapshot: async () => { throw new Error("Read must not snapshot"); },
    recheckPreconditions: async () => { throw new Error("Read must not recheck mutation preconditions"); },
  }, read.request);
  expect(execution.ipcCount).toBe(1);
  expect(execution.commandResults.get("scene-read")).toMatchObject({
    tree: { reference: { id: "selected-node", type: "cc.Node" }, name: "Selected", active: true },
    nodeCount: 1,
  });
});
