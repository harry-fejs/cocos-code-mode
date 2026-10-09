"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPublicKey, verify } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { canonicalizeToBytes } = require("../../dist/protected/canonical-json.js");
const { CcpError } = require("../../dist/protected/errors.js");
const { createCreatorAdapters } = require("../../dist/protected/creator-adapters.js");
const { DeviceIdentityStore } = require("../../dist/protected/device-identity.js");
const { MutationJournal } = require("../../dist/protected/mutation-journal.js");
const { collectObservation, recheckObservation } = require("../../dist/protected/observation-collectors.js");
const { dispatchProtectedTool } = require("../../dist/protected/protected-dispatcher.js");
const { executeEnvelope } = require("../../dist/protected/primitive-executor.js");
const { routeExecutionResult } = require("../../dist/protected/result-router.js");
const { SignedRequestCache } = require("../../dist/protected/request-builder.js");

function request(inputs = {}) {
  return {
    protocolVersion: 1,
    requestId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "abcdefghijklmnop",
    deviceId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    relayInstanceId: "44444444-4444-4444-8444-444444444444",
    sequence: 1,
    issuedAtMs: Date.now(),
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    tool: { id: "createLabel", contractVersion: 1, contractHash: "a".repeat(64) },
    relay: { build: "2.0.0", packageHash: "b".repeat(64), creatorVersion: "3.8.7", os: "win32-x64" },
    inputs,
  };
}

function effectEnvelope(commands, ipcCount, timeoutMs = 1000) {
  return {
    effect: "project-write",
    commands,
    preconditions: [{ kind: "observation", revisionToken: "r", digest: "c".repeat(64) }],
    transaction: { mode: "ordered-effect", onError: "stop", snapshot: "once-after-success" },
    return: { mode: "command-result", commandId: commands.at(-1).commandId },
    limits: { commandCount: commands.length, ipcCount, inputBytes: 262144, outputBytes: 524288, timeoutMs },
  };
}

function createChain() {
  return [
    { op: "scene.createNode", commandId: "create", usesHandles: [], createsHandle: "node", args: { parent: { source: "request", jsonPointer: "/inputs/parent" }, name: { source: "request", jsonPointer: "/inputs/name" } } },
    { op: "scene.addComponent", commandId: "component", usesHandles: ["node"], createsHandle: "component", args: { target: { source: "handle", handle: "node" }, componentType: { source: "public-contract-constant", id: "componentType" } } },
    { op: "scene.setProperties", commandId: "property", usesHandles: ["component"], args: { target: { source: "handle", handle: "component" }, values: [{ property: { source: "public-contract-constant", id: "property" }, value: { source: "request", jsonPointer: "/inputs/text" } }] } },
  ];
}
const manifest = require("../../source/protected/public-tool-manifest.json");

describe("protected relay execution behavior", () => {
  it("routes runtime controls only through fixed scene scripts", async () => {
    const calls = [];
    const invoke = createCreatorAdapters(async (...tuple) => { calls.push(tuple); return true; });
    const command = { op: "runtime.control", commandId: "pause", usesHandles: [], args: { action: "pause" } };
    assert.deepEqual(await invoke(command), { success: true });
    assert.deepEqual(calls, [["scene", "execute-scene-script", { name: "ccp3x", method: "runtimePause", args: [] }]]);
  });
  it("enforces signed IPC counts against observed Creator requests", async () => {
    let calls = 0;
    const invoke = createCreatorAdapters(async () => {
      calls += 2;
      return { success: true };
    });
    const envelope = {
      effect: "none",
      commands: [{ op: "runtime.control", commandId: "pause", usesHandles: [], args: { action: "pause" } }],
      preconditions: [],
      transaction: { mode: "read-only", onError: "stop", snapshot: "never" },
      return: { mode: "command-result", commandId: "pause" },
      limits: { commandCount: 1, ipcCount: 1, inputBytes: 262144, outputBytes: 524288, timeoutMs: 1000 },
    };
    await assert.rejects(
      executeEnvelope(envelope, {
        invoke,
        readIpcCount: () => calls,
        snapshot: async () => {},
        recheckPreconditions: async () => {},
      }, request(), { now: () => Date.now() }),
      (error) => error.body.code === "CCP_CONTRACT_MISMATCH",
    );
  });

  it("keeps compatibility asset search bounded to both supported Creator signatures", async () => {
    const calls = [];
    const invoke = createCreatorAdapters(async (...tuple) => {
      calls.push(tuple);
      if (typeof tuple[2] === "object") return { unsupported: true };
      return [{ uuid: "asset-real", type: "cc.SpriteFrame", url: "db://asset.png" }];
    });
    const result = await invoke({
      op: "asset.query",
      commandId: "search",
      usesHandles: [],
      args: { action: "search", pattern: "db://assets/**", ccType: "cc.SpriteFrame", limit: 10 },
    });
    assert.deepEqual(result, {
      assets: [{ uuid: "asset-real", type: "cc.SpriteFrame", url: "db://asset.png" }],
      total: 1,
      truncated: false,
    });
    assert.deepEqual(calls.map((call) => call[2]), [{ pattern: "db://assets/**", ccType: "cc.SpriteFrame" }, "db://assets/**"]);
  });

  it("rejects effectful calls without a stable retry key before Gateway or Creator", async () => {
    let gatewayCalls = 0;
    let creatorCalls = 0;
    let finished = 0;
    const ctx = {
      state: { beginWork: () => () => { finished += 1; } },
      client: { execute: async () => { gatewayCalls += 1; } },
      observationRuntime: { request: async () => { creatorCalls += 1; } },
    };
    await assert.rejects(dispatchProtectedTool(ctx, manifest, "createLabel", {}), (error) => error.body.code === "CCP_AUTH_REQUIRED");
    assert.deepEqual({ gatewayCalls, creatorCalls, finished }, { gatewayCalls: 0, creatorCalls: 0, finished: 1 });
  });

  it("rejects primitives outside the closed adapter ABI before Creator IPC", async () => {
    let calls = 0;
    const invoke = createCreatorAdapters(async () => { calls += 1; });
    await assert.rejects(invoke({ op: "scene.rawMessage", commandId: "raw", usesHandles: [], args: { module: "scene", message: "remove-node" } }), (error) => error.body.code === "CCP_PRIMITIVE_UNKNOWN");
    assert.equal(calls, 0);
  });

  it("uses exact fixed tuples for node lock and prefab scripts", async () => {
    const calls = [];
    const invoke = createCreatorAdapters(async (...tuple) => { calls.push(tuple); return tuple[1] === "execute-scene-script" ? null : true; });
    assert.deepEqual(await invoke({ op: "scene.operateNode", commandId: "lock", usesHandles: [], args: { action: "lock", target: "node-real", recursive: true } }), { success: true });
    assert.deepEqual(await invoke({ op: "scene.operateNode", commandId: "unwrap", usesHandles: [], args: { action: "unwrap_prefab", target: "node-real" } }), { success: true });
    assert.deepEqual(calls, [
      ["scene", "change-node-lock", "node-real", true, true],
      ["scene", "execute-scene-script", { name: "ccp3x", method: "unlinkPrefabByNode", args: ["node-real", false] }],
    ]);
  });

  it("resolves create to component to property using concrete Creator UUIDs", async () => {
    const calls = [];
    let nodeReads = 0;
    const invoke = createCreatorAdapters(async (module, message, ...args) => {
      calls.push([module, message, ...args]);
      if (message === "create-node") return "node-real";
      if (message === "query-node") return { __comps__: nodeReads++ === 0 ? [] : [{ type: "cc.Label", value: { uuid: "component-real" } }] };
      if (message === "create-component" || message === "set-property" || message === "snapshot") return true;
      throw new Error(message);
    });
    const envelope = effectEnvelope(createChain(), 6);
    const execution = await executeEnvelope(envelope, { invoke, snapshot: async () => { calls.push(["scene", "snapshot"]); }, recheckPreconditions: async () => {} }, request({ parent: "root-real", name: "Label", text: "hello" }), { publicConstants: { componentType: "cc.Label", property: "string" } });
    assert.deepEqual(execution.handles.get("node"), { id: "node-real", type: "cc.Node", kind: "node" });
    assert.deepEqual(execution.handles.get("component"), { id: "component-real", type: "cc.Label", kind: "component" });
    assert.deepEqual(calls.find((call) => call[1] === "create-component")[2], { uuid: "node-real", component: "cc.Label" });
    assert.deepEqual(calls.find((call) => call[1] === "set-property")[2], { uuid: "component-real", path: "string", dump: { value: "hello" } });
  });

  it("stale precondition performs zero effect IPC", async () => {
    let effects = 0;
    await assert.rejects(
      executeEnvelope(effectEnvelope([createChain()[0]], 2), { invoke: async () => { effects += 1; }, snapshot: async () => {}, recheckPreconditions: async () => { throw new CcpError("CCP_PRECONDITION_FAILED", "stale"); } }, request({ parent: "root", name: "x" }), { publicConstants: {} }),
      (error) => error.body.code === "CCP_PRECONDITION_FAILED",
    );
    assert.equal(effects, 0);
  });

  it("deadline before effect is safe and after attempted effect is outcome unknown", async () => {
    const envelope = effectEnvelope([createChain()[0]], 2, 20);
    let attempts = 0;
    await assert.rejects(executeEnvelope(envelope, { invoke: async () => {}, snapshot: async () => {}, recheckPreconditions: async () => {} }, request({ parent: "root", name: "x" }), { deadlineAtMs: Date.now() - 1 }), (error) => error.body.code === "CCP_EXPIRED");
    await assert.rejects(executeEnvelope(envelope, { invoke: async () => { attempts += 1; return new Promise(() => {}); }, snapshot: async () => {}, recheckPreconditions: async () => {} }, request({ parent: "root", name: "x" })), (error) => error.body.code === "CCP_OUTCOME_UNKNOWN" && error.body.details.attemptedCommandId === "create");
    assert.equal(attempts, 1);
  });

  it("stable retry key reuses exact request wrapper and conflicts on changed bytes", async () => {
    const cache = new SignedRequestCache();
    let built = 0;
    const wrapper = { request: request(), signed: { deviceKeyId: "d", payload: "p", signature: "s" }, wrapperBytes: Buffer.from("exact") };
    const first = await cache.getOrBuild("abcdefghijklmnop", "a".repeat(64), async () => { built += 1; return wrapper; });
    const second = await cache.getOrBuild("abcdefghijklmnop", "a".repeat(64), async () => { built += 1; return { ...wrapper }; });
    assert.equal(first, second);
    assert.equal(built, 1);
    await assert.rejects(cache.getOrBuild("abcdefghijklmnop", "b".repeat(64), async () => wrapper), (error) => error.body.code === "CCP_IDEMPOTENCY_CONFLICT");
  });

  it("routes ordered command-results with one signed aggregate cap", () => {
    const envelope = { return: { mode: "command-results", commandIds: ["a", "b"] }, limits: { outputBytes: 64 } };
    assert.deepEqual(routeExecutionResult(envelope, { commandResults: new Map([["a", 1], ["b", { ok: true }]]), summary: null }), { results: [1, { ok: true }] });
    assert.throws(() => routeExecutionResult({ ...envelope, limits: { outputBytes: 4 } }, { commandResults: new Map([["a", "large"]]), summary: null }), CcpError);
  });

  it("collects real bounded Creator state and rechecks the identical projection", async () => {
    let name = "Before";
    const calls = [];
    const runtime = {
      request: async (module, message, id) => {
        calls.push([module, message, id]);
        if (message === "query-node") return { uuid: id, name };
        throw new Error(`unexpected ${module}.${message}`);
      },
    };
    const spec = { contractId: "scene-target-v1", consentVersion: "scene-target-v1", fields: ["targets"] };
    const inputs = { reference: { kind: "node", id: "node-real" }, privatePayload: "not-projected" };
    const original = await collectObservation(spec, inputs, runtime);
    assert.deepEqual(original.fields, { targets: [{ id: "node-real", kind: "node", value: { uuid: "node-real", name: "Before" } }] });
    assert.equal(original.revisionToken, original.digest);
    await recheckObservation(spec, inputs, original, runtime);
    name = "After";
    await assert.rejects(recheckObservation(spec, inputs, original, runtime), (error) => error.body.code === "CCP_PRECONDITION_FAILED");
    assert.equal(calls.every((call) => call[0] === "scene" && call[1] === "query-node"), true);
  });

  it("journal replays only completed results and blocks ambiguous retries", () => {
    const completedRoot = mkdtempSync(join(homedir(), ".ccp-journal-complete-"));
    const ambiguousRoot = mkdtempSync(join(homedir(), ".ccp-journal-ambiguous-"));
    try {
      const completed = new MutationJournal(completedRoot);
      const digest = "d".repeat(64);
      completed.prepare(digest, request().requestId, "abcdefghijklmnop", 1);
      completed.markStarted(digest, "create", 2);
      completed.markCompleted(digest, { id: "node-real" }, {
        attemptedCommandIds: ["create"],
        completedCommandIds: ["create"],
        snapshot: { attempted: true, completed: true },
      }, 3);
      const replay = completed.prepare(digest, request().requestId, "abcdefghijklmnop", 4);
      assert.equal(replay.action, "return-completed");
      assert.deepEqual(replay.result, { id: "node-real" });

      const ambiguous = new MutationJournal(ambiguousRoot);
      const otherDigest = "e".repeat(64);
      ambiguous.prepare(otherDigest, request().requestId, "abcdefghijklmnop", 1);
      ambiguous.markStarted(otherDigest, "create", 2);
      ambiguous.markOutcomeUnknown(otherDigest, {
        attemptedCommandIds: ["create"],
        completedCommandIds: [],
        failingCommandId: "create",
        causalCode: "CREATOR_IPC_REJECTED",
        cause: "connection lost",
        snapshot: { attempted: true, completed: false, error: "offline" },
      }, 3);
      assert.throws(() => ambiguous.prepare(otherDigest, request().requestId, "abcdefghijklmnop", 4), (error) =>
        error.body.code === "CCP_OUTCOME_UNKNOWN"
        && error.body.details.failingCommandId === "create"
        && error.body.details.snapshotAttempted === true);
    } finally {
      rmSync(completedRoot, { recursive: true, force: true });
      rmSync(ambiguousRoot, { recursive: true, force: true });
    }
  });
});

describe("protected device identity", () => {
  it("persists enroll-ready identity unchanged and signs the exact proof base", () => {
    const root = mkdtempSync(join(homedir(), ".ccp-identity-test-"));
    try {
      const store = new DeviceIdentityStore(root);
      const first = store.loadOrCreate();
      const second = store.loadOrCreate();
      assert.deepEqual(second, first);
      const challenge = { challengeId: "55555555-5555-4555-8555-555555555555", challenge: Buffer.alloc(32, 7).toString("base64url"), memberId: "member", label: "workstation", expiresAtMs: Date.now() + 10000 };
      const proof = store.createEnrollmentProof(first, challenge);
      const signatureBase = canonicalizeToBytes({ domain: "ccp-device-enrollment-v1", ...challenge, deviceId: first.deviceId, deviceKeyId: first.deviceKeyId, publicKeySpki: first.publicKeyDer });
      const publicKey = createPublicKey({ key: Buffer.from(first.publicKeyDer, "base64url"), format: "der", type: "spki" });
      assert.equal(verify(null, signatureBase, publicKey, Buffer.from(proof.proofSignature, "base64url")), true);
      assert.deepEqual(Object.keys(proof).sort(), ["challenge", "challengeId", "deviceId", "deviceKeyId", "expiresAtMs", "label", "memberId", "proofSignature", "publicKeySpki"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses corrupt identity instead of replacing it", () => {
    const root = mkdtempSync(join(homedir(), ".ccp-identity-test-"));
    try {
      const store = new DeviceIdentityStore(root);
      const identity = store.loadOrCreate();
      const path = join(root, "device-identity-v1.json");
      writeFileSync(path, JSON.stringify({ ...identity, deviceId: "corrupt" }));
      assert.throws(() => store.loadOrCreate());
      assert.equal(JSON.parse(readFileSync(path, "utf8")).deviceId, "corrupt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
