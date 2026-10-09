"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const cli = path.resolve(__dirname, "../../scripts/verify-qualification-witness.js");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const surfaceNames = ["gateway-db-snapshot", "gateway-logs", "metrics", "relay-logs", "update-state", "support-bundle"];
const rootPointers = ["/", "/protocolVersion", "/requestId", "/idempotencyKey", "/deviceId", "/projectId", "/relayInstanceId", "/sequence", "/issuedAtMs", "/nonce", "/tool", "/tool/id", "/tool/contractVersion", "/tool/contractHash", "/relay", "/relay/build", "/relay/packageHash", "/relay/creatorVersion", "/relay/os", "/inputs"];
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-witness-validator-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binding = { projectId: randomUUID(), relayInstanceId: randomUUID(), relay: { build: "source-test", packageHash: hash("source-only"), creatorVersion: "3.7.3", os: "win32-x64" } };
  const markers = [{ label: "private-canary", value: "SOURCE_PRIVATE_CANARY_984317", allowedInGatewayRequest: false, allowedSurfaces: [] }];
  const records = ["sceneGetInfo", "nodeCreate", "nodeBatchSet", "nodeCreate"].map((toolId, index) => {
    const denied = index === 3;
    const kind = denied ? "denied" : index === 0 ? "result" : "execute";
    const start = index * 100;
    const jsonPointers = [...rootPointers];
    if (toolId !== "sceneGetInfo") {
      jsonPointers.push("/observation", "/observation/contractId", "/observation/consentVersion", "/observation/revisionToken", "/observation/digest", "/observation/fields");
      if (toolId === "nodeCreate") jsonPointers.push("/inputs/name", "/observation/fields/scene", "/observation/fields/root");
      else jsonPointers.push("/inputs/entries", "/inputs/entries/0", "/inputs/entries/0/reference", "/inputs/entries/0/reference/id", "/inputs/entries/0/propertyPaths", "/inputs/entries/0/propertyPaths/0", "/inputs/entries/0/values", "/inputs/entries/0/values/0", "/observation/fields/targets");
    }
    const phases = { "request-built": start, "transport-send": start + 1.2, "transport-response": start + 2.4 };
    if (!denied) { phases["decision-verified"] = start + 3; if (kind === "execute") { phases["execution-start"] = start + 4; phases["execution-finish"] = start + 5; } phases["result-serialized"] = start + 6; }
    return { schemaVersion: 2, evidenceScope: "source-qualification", resultBoundary: "dispatch-result-json", traceComplete: true, evidenceErrors: [], requestId: randomUUID(), toolId, binding, kind, outcome: denied ? "denied" : "completed", request: { wireBytes: 100, wireSha256: hash("wire"), decodedBytes: 60, decodedSha256: hash("decoded"), jsonPointers, pointerTruncated: false, matchedMarkers: [] }, gateway: { requests: 1, responses: 1, responseBytes: 100, concurrent: false, requestsDuringExecution: kind === "execute" ? 0 : null, responsesDuringExecution: kind === "execute" ? 0 : null }, creator: { totalIpc: kind === "execute" ? 3 : 2, observationIpc: 2, postGatewayIpc: kind === "execute" ? 1 : 0 }, result: denied ? null : { bytes: 2, sha256: hash("ok") }, phases, clock: "monotonic-ms", durationMs: 10.5 };
  });
  const surfaces = surfaceNames.map((name) => {
    const root = path.join(dir, name); fs.mkdirSync(root);
    const file = path.join(root, "snapshot.txt"); fs.writeFileSync(file, "explicit source fixture artifact\n");
    return { name, root, files: [file] };
  });
  const run = { schemaVersion: 2, runId: randomUUID(), scope: "source-qualification", evidenceScope: "source-qualification", binding, operations: records.map((record) => ({ requestId: record.requestId, toolId: record.toolId, operation: "*" })), injections: [] };
  run.injections = records.map((record, index) => {
    const fixturePath = path.join(dir, `source-${index}.json`);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, runId: run.runId, requestId: record.requestId, toolId: record.toolId, sourceKind: "local-result", payload: { privateData: markers[0].value } }));
    fs.writeFileSync(fixturePath, bytes);
    return { label: markers[0].label, runId: run.runId, requestId: record.requestId, toolId: record.toolId, fixturePath, fixtureSha256: hash(bytes), offset: bytes.indexOf(markers[0].value) };
  });
  const env = { ...process.env, CCP_QUALIFICATION_SCOPE: "source-qualification", CCP_QUALIFICATION_TRACE_PATH: path.join(dir, "trace.ndjson"), CCP_QUALIFICATION_MARKERS_PATH: path.join(dir, "markers.json"), CCP_QUALIFICATION_SURFACES_PATH: path.join(dir, "surfaces.json"), CCP_QUALIFICATION_RUN_PATH: path.join(dir, "run.json"), CCP_QUALIFICATION_REPORT_PATH: path.join(dir, "report.json") };
  delete env.CCP_QUALIFICATION_REQUIRED_TOOLS;
  const state = { dir, markers, records, surfaces, run, env };
  state.execute = () => {
    const trace = state.records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    state.run.traceSha256 = hash(trace);
    fs.writeFileSync(env.CCP_QUALIFICATION_TRACE_PATH, trace);
    fs.writeFileSync(env.CCP_QUALIFICATION_MARKERS_PATH, JSON.stringify(state.markers));
    fs.writeFileSync(env.CCP_QUALIFICATION_SURFACES_PATH, JSON.stringify(state.surfaces));
    fs.writeFileSync(env.CCP_QUALIFICATION_RUN_PATH, JSON.stringify(state.run));
    return spawnSync(process.execPath, [cli], { env, encoding: "utf8", timeout: 15000 });
  };
  return state;
}
function rejected(t, mutate) {
  const state = fixture(t); mutate(state);
  const result = state.execute();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(fs.existsSync(state.env.CCP_QUALIFICATION_REPORT_PATH), false, "rejected evidence must not publish a report");
  assert.equal(result.stderr.includes(state.markers[0]?.value || "DO_NOT_MATCH"), false);
}
test("source fixture qualification stays explicitly non-live and exposes measured observation IPC", (t) => {
  const state = fixture(t); const result = state.execute();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(state.env.CCP_QUALIFICATION_REPORT_PATH, "utf8"));
  assert.equal(report.sourceQualificationPassed, true);
  assert.equal(report.pass, false);
  assert.equal(report.signedLiveAcceptance, false);
  assert.equal(report.trace.records[3].creator.observationIpc, 2);
  assert.equal(report.trace.records[3].creator.postGatewayIpc, 0);
  assert.equal(report.probes.screenshot, "unverified-local-probe");
  assert.equal(JSON.stringify(report).includes(state.markers[0].value), false);
  assert.equal(report.surfaces.length, 6);
  for (const surface of report.surfaces) assert.equal(surface.files[0].sha256, hash("explicit source fixture artifact\n"));
});
const cases = [
  ["absent mandatory surface", (s) => s.surfaces.pop()],
  ["empty surface manifest", (s) => { s.surfaces = []; }],
  ["missing explicit surface file", (s) => { s.surfaces[0].files = []; }],
  ["missing filesystem surface", (s) => fs.rmSync(s.surfaces[0].root, { recursive: true })],
  ["control input under scan root", (s) => { s.surfaces[0].root = s.dir; }],
  ["empty marker manifest", (s) => { s.markers = []; }],
  ["zero length marker", (s) => { s.markers[0].value = ""; }],
  ["unseeded markers", (s) => { s.run.injections = []; }],
  ["unbound fixture injection", (s) => { s.run.injections[0].requestId = randomUUID(); }],
  ["wrong fixture offset", (s) => { s.run.injections[0].offset = 0; }],
  ["wrong fixture hash", (s) => { s.run.injections[0].fixtureSha256 = hash("not the fixture"); }],
  ["null execution count", (s) => { s.records[1].gateway.requestsDuringExecution = null; }],
  ["null Creator phase count", (s) => { s.records[3].creator.postGatewayIpc = null; }],
  ["denied Creator call", (s) => { s.records[3].creator.postGatewayIpc = 1; s.records[3].creator.totalIpc = 3; }],
  ["missing result end marker", (s) => { delete s.records[0].phases["result-serialized"]; }],
  ["missing execution end marker", (s) => { delete s.records[1].phases["execution-finish"]; }],
  ["null phase time", (s) => { s.records[0].phases["transport-send"] = null; }],
  ["wrong protocol root pointer", (s) => { s.records[0].request.jsonPointers.push("/credentials"); }],
  ["arbitrary input array pointer", (s) => { s.records[0].request.jsonPointers.push("/inputs/0"); }],
  ["unknown input field", (s) => { s.records[1].request.jsonPointers.push("/inputs/privateDump"); }],
  ["unknown observation field", (s) => { s.records[1].request.jsonPointers.push("/observation/fields/privateDump"); }],
  ["unexpected nested protocol field", (s) => { s.records[0].request.jsonPointers.push("/relay/credential"); }],
  ["truncated pointer inventory", (s) => { s.records[0].request.pointerTruncated = true; }],
  ["concurrent Gateway activity", (s) => { s.records[0].gateway.concurrent = true; }],
  ["hidden overlapping operation intervals", (s) => { s.records[0].durationMs = 150; }],
  ["missing completed required tool despite override", (s) => { s.records[2].outcome = "failed"; s.env.CCP_QUALIFICATION_REQUIRED_TOOLS = "sceneGetInfo"; }],
  ["missing denied scenario", (s) => { s.records.pop(); s.run.operations.pop(); s.run.injections.pop(); }],
  ["forbidden marker in Gateway request", (s) => { s.records[0].request.matchedMarkers.push("private-canary"); }],
  ["forbidden marker in scan surface", (s) => fs.writeFileSync(s.surfaces[0].files[0], s.markers[0].value)],
  ["source evidence relabeled signed-live", (s) => { s.env.CCP_QUALIFICATION_SCOPE = "signed-live"; }],
  ["ancestor alias in declared file", (s) => { s.surfaces[0].files[0] = s.surfaces[0].root + path.sep + ".." + path.sep + path.basename(s.surfaces[0].root) + path.sep + "snapshot.txt"; }],
  ["whole-run aggregate byte cap", (s) => { for (const surface of s.surfaces) fs.truncateSync(surface.files[0], 24 * 1024 * 1024); }],
];
for (const [name, mutate] of cases) test(`rejects ${name}`, (t) => rejected(t, mutate));
test("rejects symbolic-link ancestors without scanning targets", (t) => {
  const state = fixture(t); const target = state.surfaces[0].root; const alias = path.join(state.dir, "surface-alias");
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  state.surfaces[0].root = alias; state.surfaces[0].files = [path.join(alias, "snapshot.txt")];
  assert.equal(state.execute().status, 1);
});
