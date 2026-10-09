#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TRACE_MAX = 8 * 1024 * 1024;
const MANIFEST_MAX = 256 * 1024;
const RUN_MAX = 256 * 1024;
const SURFACE_FILE_MAX = 32 * 1024 * 1024;
const TOTAL_MAX = 128 * 1024 * 1024;
const FILE_COUNT_MAX = 4096;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_SURFACES = ["gateway-db-snapshot", "gateway-logs", "metrics", "relay-logs", "update-state", "support-bundle"];
const SOURCE_KINDS = new Set(["operation-input", "creator-observation", "local-result"]);
const REQUIRED_TOOLS = ["sceneGetInfo", "nodeCreate", "nodeBatchSet"];
const OUTCOMES = new Set(["completed", "denied", "failed", "outcome-unknown"]);
const KINDS = new Set(["execute", "result", "denied", "failed"]);
const PHASES = new Set(["request-built", "transport-send", "transport-response", "decision-verified", "execution-start", "execution-finish", "result-serialized"]);

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
let readBudget;
function absEnv(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  return safePath(value, name, false);
}
function safePath(input, label, mustExist) {
  if (typeof input !== "string" || !path.isAbsolute(input)) fail(`${label} must be an absolute path`);
  const normalized = path.normalize(input);
  if (input.split(/[\\/]+/).some((part) => part === "." || part === "..")) fail(`${label} contains an ancestor alias`);
  let current = path.parse(normalized).root;
  const relative = normalized.slice(current.length);
  for (const part of relative.split(/[\\/]+/).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat?.isSymbolicLink()) fail(`${label} refuses symbolic-link ancestor`);
    if (stat && !samePath(fs.realpathSync(current), current)) fail(`${label} refuses filesystem aliases`);
  }
  if (mustExist && !fs.existsSync(normalized)) fail(`${label} does not exist: ${normalized}`);
  return normalized;
}
function readBounded(file, maxBytes, label = "artifact") {
  safePath(file, label, true);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail(`${label} must be an unaliased regular file`);
  if (stat.size <= 0 || stat.size > maxBytes) fail(`${label} is empty or exceeds its byte bound`);
  readBudget.bytes += stat.size;
  readBudget.files += 1;
  if (readBudget.bytes > TOTAL_MAX || readBudget.files > FILE_COUNT_MAX) fail("whole-run artifact bounds exceeded");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail(`${label} changed before reading`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`${label} changed during reading`);
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail(`${label} changed during reading`);
    return bytes;
  } finally { fs.closeSync(fd); }
}
function readJson(file, maxBytes, label) {
  try { return JSON.parse(readBounded(file, maxBytes, label).toString("utf8")); }
  catch { fail(`${label} is unreadable, unbounded, aliased, or invalid JSON`); }
}
function contains(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function samePath(a, b) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function assertControlsOutsideSurfaces(controlPaths, surfaces) {
  for (const control of controlPaths) for (const surface of surfaces) {
    if (contains(surface.root, control) || surface.files.some((file) => samePath(file, control))) {
      fail(`control path overlaps scan surface: ${control}`);
    }
  }
}
function validHash(value, label) { if (typeof value !== "string" || !HASH.test(value)) fail(`${label} must be a sha256 hex digest`); }
function nonNegativeInt(value, label) { if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`); }
function positiveInt(value, label) { if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`); }
function stringValue(value, label) { if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) fail(`${label} must be a bounded identifier`); }
function uuid(value, label) { if (typeof value !== "string" || !UUID.test(value)) fail(`${label} must be a UUID`); }
function parseTrace(tracePath) {
  const bytes = readBounded(tracePath, TRACE_MAX, "trace");
  const lines = bytes.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) fail("trace is empty");
  if (lines.length > 256 || bytes[bytes.length - 1] !== 10) fail("trace exceeds row bound or lacks final newline");
  return { bytes, records: lines.map((line, index) => { try { return JSON.parse(line); } catch { fail(`trace line ${index + 1} is not JSON`); } }) };
}
function validateMarkers(markerPath) {
  const markers = readJson(markerPath, MANIFEST_MAX, "marker manifest");
  if (!Array.isArray(markers) || markers.length === 0 || markers.length > 32) fail("marker manifest must be a non-empty bounded array");
  const labels = new Set();
  return markers.map((marker, index) => {
    if (!isObject(marker)) fail(`marker ${index} must be an object`);
    const { label, value, allowedInGatewayRequest, allowedSurfaces } = marker;
    if (typeof label !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(label) || labels.has(label)) fail(`marker ${index} label is invalid or duplicated`);
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 8 || Buffer.byteLength(value, "utf8") > 256) fail(`marker ${label} value is invalid`);
    if (typeof allowedInGatewayRequest !== "boolean" || !Array.isArray(allowedSurfaces) || allowedSurfaces.some((name) => !REQUIRED_SURFACES.includes(name)) || new Set(allowedSurfaces).size !== allowedSurfaces.length) fail(`marker ${label} policy is invalid`);
    labels.add(label);
    return { label, value, allowedInGatewayRequest, allowedSurfaces: new Set(allowedSurfaces) };
  });
}
function validateSurfaces(surfacePath) {
  const declared = readJson(surfacePath, MANIFEST_MAX, "surface manifest");
  if (!Array.isArray(declared) || declared.length !== REQUIRED_SURFACES.length) fail("surface manifest must declare exactly the six mandatory surfaces");
  const seen = new Set();
  let totalBytes = 0;
  let fileCount = 0;
  const surfaces = declared.map((entry, index) => {
    if (!isObject(entry)) fail(`surface ${index} must be an object`);
    const name = entry.name;
    if (!REQUIRED_SURFACES.includes(name) || seen.has(name)) fail(`surface ${index} has an invalid or duplicate mandatory name`);
    const root = safePath(entry.root, `surface ${name} root`, true);
    if (!fs.lstatSync(root).isDirectory()) fail(`surface ${name} root must be a directory`);
    if (!Array.isArray(entry.files) || entry.files.length === 0) fail(`surface ${name} must declare explicit files`);
    const files = entry.files.map((value, fileIndex) => {
      const file = safePath(value, `surface ${name} file ${fileIndex}`, true);
      if (!contains(root, file) || !fs.lstatSync(file).isFile()) fail(`surface ${name} file is outside its root or not a file`);
      const size = fs.lstatSync(file).size;
      if (size <= 0 || size > SURFACE_FILE_MAX) fail(`surface ${name} file is empty or exceeds its byte bound`);
      totalBytes += size; fileCount += 1;
      if (totalBytes > TOTAL_MAX || fileCount > FILE_COUNT_MAX) fail("whole-run surface bounds exceeded");
      return file;
    });
    if (new Set(files.map((file) => process.platform === "win32" ? file.toLowerCase() : file)).size !== files.length) fail(`surface ${name} declares duplicate files`);
    seen.add(name);
    return { name, root, files };
  });
  for (const name of REQUIRED_SURFACES) if (!seen.has(name)) fail(`missing mandatory surface: ${name}`);
  for (let index = 0; index < surfaces.length; index++) for (let other = 0; other < index; other++) {
    if (contains(surfaces[index].root, surfaces[other].root) || contains(surfaces[other].root, surfaces[index].root)) fail("surface roots overlap or alias each other");
  }
  return { surfaces, totalBytes, fileCount };
}
function loadManifest(manifestPath) {
  const manifest = readJson(manifestPath, MANIFEST_MAX, "public-tool manifest");
  if (!isObject(manifest) || manifest.schemaVersion !== 2 || !Array.isArray(manifest.tools) || manifest.tools.length === 0) fail("public-tool manifest must be schemaVersion 2 with tools");
  validHash(manifest.manifestHash, "manifestHash");
  if (sha256(canonical({ schemaVersion: manifest.schemaVersion, tools: manifest.tools })) !== manifest.manifestHash) fail("public-tool manifest integrity mismatch");
  const tools = new Map();
  for (const tool of manifest.tools) {
    if (!isObject(tool) || typeof tool.name !== "string" || tools.has(tool.name) || !Array.isArray(tool.allowedInputFields) || !isObject(tool.inputSchema) || !Array.isArray(tool.inputFields) || !isObject(tool.operations)) fail("public-tool manifest has an invalid tool contract");
    const allowed = new Set(tool.allowedInputFields);
    if (tool.inputFields.some((field) => !isObject(field) || typeof field.jsonPointer !== "string" || !allowed.has(field.jsonPointer.slice(1).split("/")[0]))) fail(`manifest input field policy is invalid for ${tool.name}`);
    tools.set(tool.name, tool);
  }
  return tools;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function pointerParent(pointer) { if (pointer === "/") return null; const index = pointer.lastIndexOf("/"); return index <= 0 ? "/" : pointer.slice(0, index); }
function decodePointerPart(part) { return part.replace(/~1/g, "/").replace(/~0/g, "~"); }
function schemaAllows(schema, segments, index) {
  if (index >= segments.length) return true;
  if (!isObject(schema)) return false;
  const segment = segments[index];
  if (schema.type === "object") {
    if (!isObject(schema.properties) || !Object.prototype.hasOwnProperty.call(schema.properties, segment)) return false;
    return schemaAllows(schema.properties[segment], segments, index + 1);
  }
  if (schema.type === "array") {
    if (!/^(0|[1-9]\d*)$/.test(segment) || !isObject(schema.items) || Number(segment) >= (schema.maxItems || 512)) return false;
    return schemaAllows(schema.items, segments, index + 1);
  }
  return false;
}
function validatePointers(record, tool, operationName) {
  const pointers = record.request.jsonPointers;
  if (!Array.isArray(pointers) || pointers.length === 0 || pointers.length > 512 || record.request.pointerTruncated !== false) fail(`${record.toolId} pointer inventory is missing, truncated, or empty`);
  const unique = new Set(pointers);
  if (unique.size !== pointers.length || !unique.has("/")) fail(`${record.toolId} pointer inventory must contain unique root`);
  const fixed = ["/protocolVersion", "/requestId", "/idempotencyKey", "/deviceId", "/projectId", "/relayInstanceId", "/sequence", "/issuedAtMs", "/nonce", "/tool", "/tool/id", "/tool/contractVersion", "/tool/contractHash", "/relay", "/relay/build", "/relay/packageHash", "/relay/creatorVersion", "/relay/os", "/inputs"];
  const observation = tool.operations[operationName]?.observation;
  if (!observation || !Array.isArray(observation.fields)) fail(`${record.toolId} operation is not in public manifest`);
  for (const pointer of pointers) {
    if (typeof pointer !== "string" || pointer.length > 1024 || !pointer.startsWith("/") || pointer.includes("//") || /~(?![01])/.test(pointer)) fail(`${record.toolId} has an invalid JSON pointer`);
    const parent = pointerParent(pointer);
    if (parent && !unique.has(parent)) fail(`${record.toolId} pointer inventory omits a container`);
    if (pointer === "/" || fixed.includes(pointer) || pointer === "/observation" || pointer === "/priorTelemetry") continue;
    const parts = pointer.slice(1).split("/").map(decodePointerPart);
    if (parts[0] === "inputs") {
      const field = tool.inputFields.find((entry) => entry.jsonPointer === `/${parts[1]}`);
      if (!tool.allowedInputFields.includes(parts[1]) || !field || field.gatewayTransfer !== "allowed" || field.dataClass === "local-payload" || !schemaAllows(tool.inputSchema, parts.slice(1), 0)) fail(`${record.toolId} pointer violates public input field policy`);
    } else if (parts[0] === "observation") {
      if (parts.length === 2 && ["contractId", "consentVersion", "revisionToken", "digest", "fields"].includes(parts[1])) continue;
      if (parts[1] !== "fields" || parts.length < 3 || !observation.fields.includes(parts[2])) fail(`${record.toolId} pointer violates public observation field policy`);
    } else if (parts[0] === "priorTelemetry") {
      if (!/^(0|[1-9]\d*)$/.test(parts[1]) || Number(parts[1]) >= 100 || parts.length > 3 || (parts.length === 3 && !["requestId", "outcome", "durationMs", "errorCode"].includes(parts[2]))) fail(`${record.toolId} pointer violates telemetry shape`);
    } else fail(`${record.toolId} pointer violates exact protocol root shape`);
  }
  for (const pointer of fixed) if (!unique.has(pointer)) fail(`${record.toolId} pointer inventory omits required protocol field`);
  if (unique.has("/observation")) {
    for (const field of ["contractId", "consentVersion", "revisionToken", "digest", "fields"]) if (!unique.has(`/observation/${field}`)) fail(`${record.toolId} observation inventory is incomplete`);
    for (const field of observation.fields) if (!unique.has(`/observation/fields/${field}`)) fail(`${record.toolId} observation inventory omits approved field`);
  } else if (observation.fields.length > 0) fail(`${record.toolId} missing required observation inventory`);
  for (const field of tool.inputSchema.required || []) if (!unique.has(`/inputs/${field}`)) fail(`${record.toolId} pointer inventory omits required input`);
}
function validateRecord(record, tools, run, markerByLabel) {
  if (!isObject(record) || record.schemaVersion !== 2 || record.traceComplete !== true || !Array.isArray(record.evidenceErrors) || record.evidenceErrors.length !== 0) fail("trace row is incomplete or reports evidence errors");
  if (record.evidenceScope !== "source-qualification" || record.resultBoundary !== "dispatch-result-json") fail("trace must declare its source-only evidence boundary");
  uuid(record.requestId, "requestId"); stringValue(record.toolId, "toolId");
  const tool = tools.get(record.toolId); if (!tool) fail(`trace tool is not in public manifest: ${record.toolId}`);
  if (!KINDS.has(record.kind) || !OUTCOMES.has(record.outcome)) fail(`${record.toolId} has invalid kind/outcome`);
  if (!isObject(record.binding) || typeof record.binding.projectId !== "string" || typeof record.binding.relayInstanceId !== "string" || !isObject(record.binding.relay)) fail(`${record.toolId} binding is invalid`);
  if (canonical(record.binding) !== canonical(run.binding)) fail(`${record.toolId} binding does not match run identity`);
  if (!isObject(record.request) || !isObject(record.gateway) || !isObject(record.creator) || !isObject(record.phases)) fail(`${record.toolId} evidence sections are missing`);
  for (const field of ["wireBytes", "decodedBytes"]) positiveInt(record.request[field], `${record.toolId} request.${field}`);
  for (const field of ["wireSha256", "decodedSha256"]) validHash(record.request[field], `${record.toolId} request.${field}`);
  const operation = run.operations.find((entry) => entry.requestId === record.requestId && entry.toolId === record.toolId);
  if (!operation) fail(`${record.toolId} row is not bound to an explicit operation`);
  validatePointers(record, tool, operation.operation);
  if (!Array.isArray(record.request.matchedMarkers) || record.request.matchedMarkers.length > markerByLabel.size || new Set(record.request.matchedMarkers).size !== record.request.matchedMarkers.length) fail(`${record.toolId} matchedMarkers must be a bounded unique array`);
  for (const label of record.request.matchedMarkers) {
    const marker = markerByLabel.get(label); if (!marker) fail(`${record.toolId} refers to an unknown marker`);
    if (!marker.allowedInGatewayRequest) fail(`forbidden marker reached Gateway request: ${label}`);
    if (!run.injections.some((injection) => injection.label === label && injection.requestId === record.requestId && injection.toolId === record.toolId)) fail(`marker ${label} has no bound injection for ${record.toolId}`);
  }
  if (record.gateway.requests !== 1 || record.gateway.responses !== 1 || !Number.isInteger(record.gateway.responseBytes) || record.gateway.responseBytes <= 0 || typeof record.gateway.concurrent !== "boolean") fail(`${record.toolId} Gateway counts are not measured exactly`);
  if (record.gateway.concurrent !== false) fail(`${record.toolId} has concurrent Gateway activity`);
  if (!isObject(record.creator)) fail(`${record.toolId} creator evidence is missing`);
  for (const field of ["totalIpc", "observationIpc", "postGatewayIpc"]) nonNegativeInt(record.creator[field], `${record.toolId} creator.${field}`);
  if (record.creator.totalIpc !== record.creator.observationIpc + record.creator.postGatewayIpc) fail(`${record.toolId} Creator IPC counters do not reconcile`);
  if (!Number.isFinite(record.durationMs) || record.durationMs < 0 || record.clock !== "monotonic-ms") fail(`${record.toolId} clock/duration is invalid`);
  for (const [phase, value] of Object.entries(record.phases)) { if (!PHASES.has(phase) || !Number.isFinite(value) || value < 0) fail(`${record.toolId} phase is invalid`); }
  for (const phase of ["request-built", "transport-send", "transport-response"]) if (!Object.hasOwn(record.phases, phase)) fail(`${record.toolId} missing required phase ${phase}`);
  if (record.kind === "execute") {
    if (record.outcome === "denied" || !Object.hasOwn(record.phases, "execution-start") || !Object.hasOwn(record.phases, "execution-finish")) fail(`${record.toolId} execute row lacks execution markers`);
    if (record.gateway.requestsDuringExecution !== 0 || record.gateway.responsesDuringExecution !== 0) fail(`${record.toolId} accessed Gateway during execution`);
  } else {
    if (record.gateway.requestsDuringExecution !== null || record.gateway.responsesDuringExecution !== null) fail(`${record.toolId} non-execute row must use null execution deltas`);
    if (Object.hasOwn(record.phases, "execution-start") || Object.hasOwn(record.phases, "execution-finish")) fail(`${record.toolId} non-execute row contains execution markers`);
  }
  if (record.kind === "denied") {
    if (record.outcome !== "denied" || record.creator.postGatewayIpc !== 0 || record.result !== null) fail(`${record.toolId} denied row is not fail-closed`);
  } else if (record.kind === "result" || record.kind === "execute") {
    if (record.outcome !== "completed" || !isObject(record.result)) fail(`${record.toolId} successful row lacks completed result evidence`);
    positiveInt(record.result.bytes, `${record.toolId} result.bytes`); validHash(record.result.sha256, `${record.toolId} result.sha256`);
    for (const phase of ["decision-verified", "result-serialized"]) if (!Object.hasOwn(record.phases, phase)) fail(`${record.toolId} missing required end marker`);
    if (record.kind === "result" && record.creator.postGatewayIpc !== 0) fail(`${record.toolId} finite result reached Creator IPC`);
  } else fail(`${record.toolId} failed/outcome-unknown evidence cannot qualify`);
  const ordered = [...PHASES].filter((phase) => Object.hasOwn(record.phases, phase)).map((phase) => record.phases[phase]);
  if (ordered.some((value, index) => index > 0 && value < ordered[index - 1]) || ordered.at(-1) - ordered[0] > record.durationMs + 0.001) fail(`${record.toolId} phase order or duration is inconsistent`);
  return { toolId: record.toolId, kind: record.kind, outcome: record.outcome, requestId: record.requestId, gateway: record.gateway, creator: record.creator, result: record.result, phases: record.phases, request: { wireBytes: record.request.wireBytes, wireSha256: record.request.wireSha256, decodedBytes: record.request.decodedBytes, decodedSha256: record.request.decodedSha256 } };
}
function validateInjections(run, markers, controls) {
  if (!Array.isArray(run.injections) || run.injections.length === 0 || run.injections.length > 1024) fail("run identity has no bounded canary injection provenance");
  const byLabel = new Map(markers.map((marker) => [marker.label, marker]));
  for (const injection of run.injections) {
    if (!isObject(injection) || !byLabel.has(injection.label) || injection.runId !== run.runId || typeof injection.fixturePath !== "string" || !path.isAbsolute(injection.fixturePath)) fail("canary injection provenance is invalid");
    const marker = byLabel.get(injection.label);
    const fixture = safePath(injection.fixturePath, "canary fixture", true);
    if (controls.some((control) => samePath(control, fixture))) fail("canary fixture overlaps control input");
    const bytes = readBounded(fixture, SURFACE_FILE_MAX, "canary fixture");
    let source;
    try { source = JSON.parse(bytes.toString("utf8")); } catch { fail("canary fixture must be a bound source envelope"); }
    if (!isObject(source) || source.schemaVersion !== 2 || source.runId !== run.runId || source.requestId !== injection.requestId || source.toolId !== injection.toolId || !SOURCE_KINDS.has(source.sourceKind) || !Object.hasOwn(source, "payload")) fail("canary source fixture is not bound to this operation");
    const payload = JSON.stringify(source.payload);
    if (!payload.includes(marker.value)) fail(`canary ${injection.label} was not seeded into source payload`);
    validHash(injection.fixtureSha256, "canary fixtureSha256");
    if (sha256(bytes) !== injection.fixtureSha256) fail(`canary fixture hash mismatch for ${injection.label}`);
    if (!Number.isInteger(injection.offset) || injection.offset < 0 || injection.offset + Buffer.byteLength(marker.value, "utf8") > bytes.length || !bytes.subarray(injection.offset, injection.offset + Buffer.byteLength(marker.value, "utf8")).equals(Buffer.from(marker.value))) fail(`canary fixture offset does not prove injection for ${injection.label}`);
    uuid(injection.requestId, "injection requestId"); stringValue(injection.toolId, "injection toolId");
    if (!run.operations.some((operation) => operation.requestId === injection.requestId && operation.toolId === injection.toolId)) fail(`canary injection is not bound to an operation for ${injection.label}`);
    if (source.sourceKind === "operation-input" || source.sourceKind === "creator-observation") {
      const record = run.records.find((entry) => entry.requestId === injection.requestId);
      if (!record?.request?.matchedMarkers?.includes(injection.label)) fail(`seeded request canary ${injection.label} lacks observed request evidence`);
    }
  }
  for (const marker of markers) if (!run.injections.some((injection) => injection.label === marker.label)) fail(`marker ${marker.label} has no source fixture provenance`);
  for (const operation of run.operations) if (!run.injections.some((injection) => injection.requestId === operation.requestId && injection.toolId === operation.toolId)) fail("operation has no bound canary injection provenance");
}
function scanSurfaces(surfaces, markers) {
  const markerCounts = Object.fromEntries(markers.map((marker) => [marker.label, 0]));
  const reports = [];
  for (const surface of surfaces) {
    const hashes = [];
    let bytesTotal = 0;
    for (const file of surface.files) {
      const content = readBounded(file, SURFACE_FILE_MAX, `surface ${surface.name}`);
      bytesTotal += content.length;
      const fileId = sha256(path.relative(surface.root, file).replaceAll("\\", "/"));
      const fileCounts = {};
      for (const marker of markers) {
        const needle = Buffer.from(marker.value, "utf8"); let offset = 0; let count = 0;
        while ((offset = content.indexOf(needle, offset)) !== -1) { count += 1; offset += needle.length; }
        fileCounts[marker.label] = count; markerCounts[marker.label] += count;
        if (count > 0 && !marker.allowedSurfaces.has(surface.name)) fail(`forbidden marker ${marker.label} found in ${surface.name}`);
      }
      hashes.push({ fileId, bytes: content.length, sha256: sha256(content), markerCounts: fileCounts });
    }
    reports.push({ name: surface.name, bytes: bytesTotal, fileCount: hashes.length, files: hashes });
  }
  return { reports, markerCounts };
}
function validateQualification() {
  readBudget = { bytes: 0, files: 0 };
  const scope = process.env.CCP_QUALIFICATION_SCOPE;
  if (scope !== "source-qualification" && scope !== "signed-live") fail("CCP_QUALIFICATION_SCOPE must be explicitly source-qualification or signed-live");
  if (scope === "signed-live") fail("signed-live acceptance is false: independent external evidence is required");
  const tracePath = absEnv("CCP_QUALIFICATION_TRACE_PATH");
  const markerPath = absEnv("CCP_QUALIFICATION_MARKERS_PATH");
  const surfacePath = absEnv("CCP_QUALIFICATION_SURFACES_PATH");
  const runPath = absEnv("CCP_QUALIFICATION_RUN_PATH");
  const reportPath = absEnv("CCP_QUALIFICATION_REPORT_PATH");
  const manifestPath = path.resolve(__dirname, "../source/protected/public-tool-manifest.json");
  const controls = [tracePath, markerPath, surfacePath, runPath, reportPath, manifestPath].map((value) => safePath(value, "control path", false));
  if (new Set(controls.map((file) => process.platform === "win32" ? file.toLowerCase() : file)).size !== controls.length) fail("control inputs overlap each other");
  const markerList = validateMarkers(markerPath);
  const surfaceData = validateSurfaces(surfacePath);
  assertControlsOutsideSurfaces(controls, surfaceData.surfaces);
  const run = readJson(runPath, RUN_MAX, "run identity");
  if (!isObject(run) || run.schemaVersion !== 2 || run.scope !== scope || run.evidenceScope !== "source-qualification") fail("run identity must explicitly declare schemaVersion 2 source qualification scope");
  uuid(run.runId, "runId");
  if (!isObject(run.binding) || typeof run.binding.projectId !== "string" || typeof run.binding.relayInstanceId !== "string" || !isObject(run.binding.relay)) fail("run binding is invalid");
  uuid(run.binding.projectId, "projectId"); uuid(run.binding.relayInstanceId, "relayInstanceId");
  validHash(run.binding.relay.packageHash, "relay packageHash");
  for (const field of ["build", "creatorVersion", "os"]) stringValue(run.binding.relay[field], `relay ${field}`);
  if (Object.keys(run.binding).sort().join(",") !== "projectId,relay,relayInstanceId" || Object.keys(run.binding.relay).sort().join(",") !== "build,creatorVersion,os,packageHash") fail("run binding has unexpected fields");
  validHash(run.traceSha256, "run traceSha256");
  const trace = parseTrace(tracePath);
  if (sha256(trace.bytes) !== run.traceSha256) fail("run trace hash does not match trace artifact");
  if (!Array.isArray(run.operations) || run.operations.length === 0 || run.operations.length > 256) fail("run identity has no bounded operations");
  for (const operation of run.operations) { if (!isObject(operation)) fail("run operation is invalid"); uuid(operation.requestId, "operation requestId"); stringValue(operation.toolId, "operation toolId"); if (typeof operation.operation !== "string" || !/^[A-Za-z0-9._:*-]{1,128}$/.test(operation.operation)) fail("operation contract identifier is missing"); }
  if (new Set(run.operations.map((operation) => operation.requestId)).size !== run.operations.length || new Set(trace.records.map((record) => record.requestId)).size !== trace.records.length || trace.records.length !== run.operations.length) fail("run and trace must contain the same unique operations");
  const tools = loadManifest(manifestPath);
  run.records = trace.records;
  validateInjections(run, markerList, controls);
  const markerByLabel = new Map(markerList.map((marker) => [marker.label, marker]));
  const records = trace.records.map((record) => validateRecord(record, tools, run, markerByLabel));
  const requiredTools = new Set([...REQUIRED_TOOLS, ...(process.env.CCP_QUALIFICATION_REQUIRED_TOOLS || "").split(",").filter(Boolean)]);
  for (const toolId of requiredTools) if (!records.some((record) => record.toolId === toolId && record.kind !== "denied" && record.outcome === "completed")) fail(`missing required completed scenario`);
  if (!records.some((record) => record.kind === "denied" && record.outcome === "denied")) fail("missing required denied scenario");
  const ordered = [...trace.records].sort((a, b) => a.phases["request-built"] - b.phases["request-built"]);
  for (let index = 1; index < ordered.length; index++) if (ordered[index].phases["request-built"] < ordered[index - 1].phases["request-built"] + ordered[index - 1].durationMs) fail("trace operation intervals overlap despite concurrency declaration");
  const surfaces = scanSurfaces(surfaceData.surfaces, markerList);
  const report = {
    schemaVersion: 2,
    pass: false,
    qualificationStatus: "source-qualified",
    sourceQualificationPassed: true,
    signedLiveAcceptance: false,
    evidenceScope: "source-qualification",
    resultBoundary: "dispatch-result-json",
    run: { runId: run.runId, scope, binding: run.binding },
    trace: { sha256: sha256(trace.bytes), bytes: trace.bytes.length, records },
    surfaces: surfaces.reports,
    bounds: { readFiles: readBudget.files, readBytes: readBudget.bytes, surfaceFiles: surfaceData.fileCount, surfaceBytes: surfaceData.totalBytes },
    probes: { screenshot: "unverified-local-probe", largeResult: "unverified", httpReturn: "unverified" },
    markerCounts: surfaces.markerCounts,
    limitations: ["Source fixtures prove bounded source qualification only; they do not prove signed-live behavior or HTTP/trimmer callback serialization.", "Result hashes are dispatcher-result JSON boundaries, not independent Gateway HTTP return evidence.", "Screenshot and large-result probes remain unverified when absent; screenshot is local and is never synthesized as a Gateway round trip.", "Marker values and raw credentials are intentionally omitted from this report."],
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(output) > 4 * 1024 * 1024) fail("report exceeds byte bound");
  if (markerList.some((marker) => output.includes(marker.value))) fail("report metadata contains a marker value");
  safePath(reportPath, "report path", false);
  fs.writeFileSync(reportPath, output, { flag: "wx", mode: 0o600 });
  return report;
}
if (require.main === module) {
  try { const report = validateQualification(); console.log(JSON.stringify({ pass: false, sourceQualificationPassed: report.sourceQualificationPassed, signedLiveAcceptance: report.signedLiveAcceptance, qualificationStatus: report.qualificationStatus, records: report.trace.records.length })); }
  catch (error) { console.error(`qualification witness failed: ${error.code ? "artifact filesystem operation failed" : error.message}`); process.exitCode = 1; }
}
module.exports = { validateQualification };
