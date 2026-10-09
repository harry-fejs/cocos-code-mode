"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { generateKeyPairSync, sign, randomUUID } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { canonicalizeToBytes } = require("../../dist/protected/canonical-json.js");
const { dispatchProtectedTool } = require("../../dist/protected/protected-dispatcher.js");
const { QualificationTraceRecorder } = require("../../dist/protected/qualification-trace.js");
const { decisionSignatureBase } = require("../../dist/protected/protocol.js");
const { ReplayWindow } = require("../../dist/protected/replay-window.js");
const { GatewayClient } = require("../../dist/protected/gateway-client.js");
const { SignedRequestCache } = require("../../dist/protected/request-builder.js");
const manifest = require("../../source/protected/public-tool-manifest.json");

async function surface(run) {
  const directory = mkdtempSync(join(homedir(), ".ccp-trace-http-"));
  const tracePath = join(directory, "trace.ndjson");
  const markerPath = join(directory, "markers.json");
  writeFileSync(markerPath, JSON.stringify([{ label: "approved-name", value: "APPROVED_MARKER_1234" }]));
  const trace = new QualificationTraceRecorder(tracePath, markerPath);
  const execution = generateKeyPairSync("ed25519");
  const device = generateKeyPairSync("ed25519");
  let requests = 0;
  const payloads = [];
  let ipc = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const wrapper = JSON.parse(Buffer.concat(chunks));
    const request = JSON.parse(Buffer.from(wrapper.payload, "base64url"));
    payloads.push(request);
    res.setHeader("content-type", "application/json");
    if (request.tool.id === "nodeCreate") {
      res.statusCode = 422;
      res.end(JSON.stringify({ code: "CCP_PROJECT_DENIED", error: "denied", details: {}, recovery: "Request a scoped grant." }));
      return;
    }
    const tool = manifest.tools.find(t => t.name === request.tool.id);
    const binding = { requestId: request.requestId, deviceId: request.deviceId, projectId: request.projectId,
      relayInstanceId: request.relayInstanceId, nonce: request.nonce, sequence: request.sequence, tool: request.tool,
      relay: { build: request.relay.build, packageHash: request.relay.packageHash }, creatorRange: tool.creatorRange,
      issuedAtMs: request.issuedAtMs, expiresAtMs: request.issuedAtMs + 5000 };
    const decision = { kind: "execute", correlationId: randomUUID(), binding, envelope: {
      effect: "none", commands: [{ op: "scene.readNode", commandId: "scene-read", usesHandles: [], args: { action: "scene-info" } }],
      preconditions: [], transaction: { mode: "read", onError: "stop", snapshot: "none" },
      return: { mode: "command-result", commandId: "scene-read" },
      limits: { commandCount: 1, ipcCount: 3, inputBytes: 0, outputBytes: tool.limits.outputBytes, timeoutMs: 5000 },
    } };
    const payload = canonicalizeToBytes(decision);
    res.end(JSON.stringify({ executionKeyId: "trace-key", payload: payload.toString("base64url"),
      signature: sign(null, decisionSignatureBase("trace-key", payload), execution.privateKey).toString("base64url") }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new GatewayClient({ origin: `http://127.0.0.1:${server.address().port}`, allowInsecureLoopback: true,
    memberCredential: () => "member-secret-do-not-record", qualificationTrace: trace });
  const sequence = new ReplayWindow();
  const context = {
    state: { beginWork: () => () => {} }, identity: { deviceId: randomUUID(), deviceKeyId: "device-test" },
    identityStore: { privateKey: () => device.privateKey }, projectId: randomUUID(), relayInstanceId: randomUUID(),
    sequence, replayWindow: sequence, journal: {}, requestCache: new SignedRequestCache(), client,
    executionKeys: new Map([["trace-key", execution.publicKey]]),
    relay: { build: "2.0.0", packageHash: "b".repeat(64), creatorVersion: "3.7.3", os: "win32-x64" },
    adapters: { invoke: async () => { ipc += 3; return { dirty: false }; },
      snapshot: async () => {}, readIpcCount: () => ipc },
    observationRuntime: { request: async () => { ipc++; return {}; } }, qualificationTrace: trace,
    telemetry: new (require("../../dist/protected/telemetry-buffer.js").TelemetryBuffer)(),
  };
  try { await run({ context, trace, directory, tracePath, resetIpc: () => { ipc = 0; }, requests: () => requests, payloads: () => payloads }); }
  finally { trace.close(); client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
}

test("real transport records read execution and denied mutation without fabricating observation IPC", async () => {
  await surface(async ({ context, tracePath, resetIpc, requests }) => {
    assert.deepEqual(await dispatchProtectedTool(context, manifest, "sceneGetInfo", {}), { dirty: false });
    resetIpc();
    await assert.rejects(dispatchProtectedTool(context, manifest, "nodeCreate", { name: "APPROVED_MARKER_1234" }, { idempotencyKey: randomUUID() }), e => e.body.code === "CCP_PROJECT_DENIED");
    const raw = readFileSync(tracePath, "utf8");
    const [read, denied] = raw.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(requests(), 2);
    assert.equal(read.traceComplete, true);
    assert.equal(read.gateway.requestsDuringExecution, 0);
    assert.equal(read.gateway.responsesDuringExecution, 0);
    assert.deepEqual(read.creator, { totalIpc: 3, observationIpc: 0, postGatewayIpc: 3 });
    assert.equal(read.gateway.requests, 1);
    assert.equal(read.gateway.responses, 1);
    assert.equal(denied.outcome, "denied");
    assert.deepEqual(denied.creator, { totalIpc: 2, observationIpc: 2, postGatewayIpc: 0 });
    assert.deepEqual(denied.request.matchedMarkers, ["approved-name"]);
    assert.equal(raw.includes("APPROVED_MARKER_1234"), false);
    assert.equal(raw.includes("member-secret-do-not-record"), false);
  });
});
test("completion telemetry is attached to the next non-idempotent protected request", async () => {
  await surface(async ({ context, payloads }) => {
    await dispatchProtectedTool(context, manifest, "sceneGetInfo", {});
    await dispatchProtectedTool(context, manifest, "sceneGetInfo", {});
    assert.equal(payloads().length, 2);
    assert.equal(payloads()[0].priorTelemetry, undefined);
    assert.equal(payloads()[1].priorTelemetry.length, 1);
    assert.equal(payloads()[1].priorTelemetry[0].requestId, payloads()[0].requestId);
    assert.equal(payloads()[1].priorTelemetry[0].outcome, "completed");
    assert.equal(Number.isSafeInteger(payloads()[1].priorTelemetry[0].durationMs), true);
  });
});
test("gateway denials are not reported as Creator completion failures", async () => {
  await surface(async ({ context, payloads }) => {
    const retryKey = randomUUID();
    await assert.rejects(dispatchProtectedTool(context, manifest, "nodeCreate", { name: "APPROVED_MARKER_1234" }, { idempotencyKey: retryKey }), e => e.body.code === "CCP_PROJECT_DENIED");
    await assert.rejects(dispatchProtectedTool(context, manifest, "nodeCreate", { name: "APPROVED_MARKER_1234" }, { idempotencyKey: retryKey }), e => e.body.code === "CCP_PROJECT_DENIED");
    await dispatchProtectedTool(context, manifest, "sceneGetInfo", {});
    assert.equal(payloads().length, 3);
    assert.equal(payloads()[0].priorTelemetry, undefined);
    assert.equal(payloads()[1].priorTelemetry, undefined);
    assert.equal(payloads()[2].priorTelemetry, undefined);
  });
});

test("idempotent cache hits do not fabricate Creator completion telemetry", async () => {
  await surface(async ({ context, payloads }) => {
    const retryKey = randomUUID();
    await assert.rejects(dispatchProtectedTool(context, manifest, "nodeCreate", { name: "APPROVED_MARKER_1234" }, { idempotencyKey: retryKey }), e => e.body.code === "CCP_PROJECT_DENIED");
    await assert.rejects(dispatchProtectedTool(context, manifest, "nodeCreate", { name: "APPROVED_MARKER_1234" }, { idempotencyKey: retryKey }), e => e.body.code === "CCP_PROJECT_DENIED");
    await dispatchProtectedTool(context, manifest, "sceneGetInfo", {});
    assert.equal(payloads().length, 3);
    assert.equal(payloads()[1].requestId, payloads()[0].requestId);
    assert.equal(payloads()[1].priorTelemetry, undefined);
    assert.equal(payloads()[2].priorTelemetry, undefined);
  });
});

test("trace I/O failure after Creator execution preserves the successful tool outcome", async () => {
  await surface(async ({ context, trace }) => {
    trace.close();
    assert.deepEqual(await dispatchProtectedTool(context, manifest, "sceneGetInfo", {}), { dirty: false });
  });
});

test("trace refuses replacing an existing evidence file", async () => {
  await surface(async ({ tracePath }) => {
    assert.throws(() => new QualificationTraceRecorder(tracePath), /EEXIST/);
  });
});

test("concurrent operations invalidate isolation evidence rather than cross-attribute traffic", async () => {
  await surface(async ({ context, tracePath }) => {
    await Promise.all([dispatchProtectedTool(context, manifest, "sceneGetInfo", {}), dispatchProtectedTool(context, manifest, "sceneGetInfo", {})]);
    const rows = readFileSync(tracePath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows.every(row => !row.traceComplete && row.gateway.concurrent), true);
  });
});

test("unavailable Creator counters remain unknown, never inferred zero", async () => {
  await surface(async ({ context, tracePath }) => {
    delete context.adapters.readIpcCount;
    await dispatchProtectedTool(context, manifest, "sceneGetInfo", {});
    const row = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.deepEqual(row.creator, { totalIpc: null, observationIpc: null, postGatewayIpc: null });
  });
});
