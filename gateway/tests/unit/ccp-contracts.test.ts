import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PublicToolRegistry } from "../../src/ccp/public-tool-registry.ts";
import { ExecutionEnvelopeSchema, PrimitiveCommandSchema, primitiveCommandSemantics } from "../../src/ccp/primitive-contract.ts";
import {
  ALL_PUBLIC_TOOLS,
  PUBLIC_TOOL_MANIFEST,
  hashPublicToolBehavior,
  hashPublicToolManifest,
  publicToolBehavior,
} from "../../src/ccp/tool-catalog.ts";
import type { PublicToolBehavior } from "../../src/ccp/schemas.ts";

const root = resolve(import.meta.dirname, "../../..");
const relayManifest = JSON.parse(readFileSync(resolve(root, "source/protected/public-tool-manifest.json"), "utf8"));
const gatewayFixture = JSON.parse(readFileSync(resolve(root, "gateway/tests/fixtures/ccp/v1/public-tool-manifest.json"), "utf8"));
const relayFixture = JSON.parse(readFileSync(resolve(root, "tests/fixtures/protected/v1/public-tool-manifest.json"), "utf8"));

function changedHash(behavior: PublicToolBehavior, change: (copy: PublicToolBehavior) => void): string {
  const copy = structuredClone(behavior);
  change(copy);
  return hashPublicToolBehavior(copy);
}

describe("CCP public contracts", () => {
  it("exports the exact canonical 45-tool artifact on Gateway and relay", () => {
    const registry = new PublicToolRegistry();
    const names = registry.exportManifest().tools.map((tool) => tool.name);
    expect(names).toEqual([...ALL_PUBLIC_TOOLS].sort());
    expect(names).toHaveLength(43);
    expect(relayManifest).toEqual(PUBLIC_TOOL_MANIFEST);
    expect(gatewayFixture).toEqual(PUBLIC_TOOL_MANIFEST);
    expect(relayFixture).toEqual(PUBLIC_TOOL_MANIFEST);
    expect(hashPublicToolManifest(PUBLIC_TOOL_MANIFEST)).toBe(PUBLIC_TOOL_MANIFEST.manifestHash);
    for (const tool of PUBLIC_TOOL_MANIFEST.tools) {
      expect(registry.get(tool.name, tool.contractVersion)).toEqual(tool);
      expect(tool.primitiveAbiVersion).toBe(2);
      expect(hashPublicToolBehavior(publicToolBehavior(tool))).toBe(tool.contractHash);
    }
  });

  it("binds every public behavior category into each content hash", () => {
    for (const contract of PUBLIC_TOOL_MANIFEST.tools) {
      const behavior = publicToolBehavior(contract);
      expect(changedHash(behavior, (copy) => { copy.limits.timeoutMs -= 1; })).not.toBe(contract.contractHash);
    }
    const behavior = publicToolBehavior(PUBLIC_TOOL_MANIFEST.tools.find((tool) => tool.name === "animationEdit")!);
    const mutations: Array<(copy: PublicToolBehavior) => void> = [
      (copy) => { copy.inputSchema = { ...copy.inputSchema, title: "changed" }; },
      (copy) => { copy.outputSchema = { ...copy.outputSchema, title: "changed" }; },
      (copy) => { copy.plannerId = `${copy.plannerId}.changed`; },
      (copy) => { copy.operations.record_start.observation.fields = ["animationTarget", "changed"]; },
      (copy) => { copy.operations.record_start.primitives = ["scene.lifecycle"]; },
      (copy) => { copy.operations.record_start.effect = "local-state"; },
      (copy) => { copy.publicConstants = { changed: true }; },
      (copy) => { copy.allowedValueSources = ["request"]; },
    ];
    for (const mutate of mutations) expect(changedHash(behavior, mutate)).not.toBe(hashPublicToolBehavior(behavior));
  });

  it("accepts request provenance and exact IPC/result aggregation contracts", () => {
    const request = (jsonPointer: string) => ({ source: "request" as const, jsonPointer });
    const component = PrimitiveCommandSchema.parse({
      op: "scene.readComponent",
      commandId: "components",
      usesHandles: [],
      args: { action: "on-node", target: request("/reference"), componentType: request("/componentType") },
    });
    expect(component.op).toBe("scene.readComponent");
    if (component.op !== "scene.readComponent") throw new Error("unexpected primitive");
    expect(component.args.componentType).toEqual(request("/componentType"));


    const set = PrimitiveCommandSchema.parse({
      op: "scene.setProperties",
      commandId: "set",
      usesHandles: [],
      args: {
        target: request("/reference"),
        values: [
          { property: request("/propertyPaths/0"), value: request("/values/0") },
          { property: request("/propertyPaths/1"), value: request("/values/1") },
        ],
      },
    });
    expect(set.op).toBe("scene.setProperties");
    if (set.op !== "scene.setProperties") throw new Error("unexpected primitive");
    expect(set.args.values[0].property).toEqual(request("/propertyPaths/0"));
    expect(primitiveCommandSemantics(set).ipcCount).toBe(2);

    const queryCommands = [0, 1].map((index) => ({
      op: "asset.query" as const,
      commandId: `query-${index}`,
      usesHandles: [],
      args: { action: "search" as const, pattern: request(`/queries/${index}/pattern`) },
    }));
    const envelope = ExecutionEnvelopeSchema.parse({
      effect: "none",
      commands: queryCommands,
      preconditions: [],
      transaction: { mode: "read", onError: "stop", snapshot: "none" },
      return: { mode: "command-results", commandIds: queryCommands.map((command) => command.commandId) },
      limits: { commandCount: 2, ipcCount: 4, inputBytes: 1024, outputBytes: 4096, timeoutMs: 1000 },
    });
    expect(envelope.return).toEqual({ mode: "command-results", commandIds: ["query-0", "query-1"] });
    expect(PUBLIC_TOOL_MANIFEST.tools.find((tool) => tool.name === "assetBatchQuery")?.operations["*"].resultMode).toBe("command-results");
    const mixedEnvelope = ExecutionEnvelopeSchema.parse({
      effect: "project-write",
      commands: [
        {
          op: "scene.createNode",
          commandId: "button",
          usesHandles: [],
          createsHandle: "button-node",
          args: { parent: request("/parentReference"), name: request("/name"), prefab: { source: "public-contract-constant", id: "prefab" } },
        },
        {
          op: "scene.readNode",
          commandId: "button-children",
          usesHandles: ["button-node"],
          args: { action: "tree", target: { source: "handle", handle: "button-node" } },
        },
        {
          op: "scene.setProperties",
          commandId: "button-label",
          usesHandles: ["button-node"],
          args: { target: { source: "handle", handle: "button-node" }, values: [{ property: { source: "public-contract-constant", id: "labelPropertyPath" }, value: request("/text") }] },
        },
      ],
      preconditions: [{ kind: "observation", revisionToken: "revision", digest: "c".repeat(64) }],
      transaction: { mode: "ordered-effect", onError: "stop", snapshot: "once-after-success" },
      return: { mode: "command-result", commandId: "button" },
      limits: { commandCount: 3, ipcCount: 5, inputBytes: 1024, outputBytes: 4096, timeoutMs: 1000 },
    });
    expect(mixedEnvelope.effect).toBe("project-write");
  });

  it("removes generic animation dispatch and bounds project setting metadata", () => {
    const animation = PUBLIC_TOOL_MANIFEST.tools.find((tool) => tool.name === "animationEdit")!;
    expect(animation.contractVersion).toBe(2);
    expect(Object.keys(animation.operations)).not.toContain("operate");
    expect(animation.allowedInputFields).not.toContain("operations");
    const project = PUBLIC_TOOL_MANIFEST.tools.find((tool) => tool.name === "projectManage")!;
    const key = project.inputFields.find((field) => field.jsonPointer === "/key");
    const path = project.inputFields.find((field) => field.jsonPointer === "/path");
    expect(key).toMatchObject({ dataClass: "project-metadata", maxBytes: 4096, gatewayTransfer: "allowed" });
    expect(path).toMatchObject({ dataClass: "project-metadata", maxBytes: 4096, gatewayTransfer: "allowed" });
    expect(project.operations.get.effect).toBe("none");
    expect(project.operations.set.effect).toBe("project-write");
  });
});
