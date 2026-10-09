'use strict';
const { sha, read, json, write, installed, signedEvents, scan } = require('./installed-live-qualification');
const HASH = /^[a-f0-9]{64}$/;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
function creditOperation(operation, scenario, events, run) {
  const gaps = [];
  const httpRows = events.filter(e => e.type === 'http-result' && e.callId === operation.callId);
  const dispatchRows = events.filter(e => e.type === 'protected-dispatch' && e.callId === operation.callId);
  const boundary = httpRows.length === 1 ? httpRows[0] : null;
  if (!operation.http || !boundary || !boundary.finished || boundary.resultBoundary !== 'local-http-response-bytes' || boundary.toolId !== operation.toolId || boundary.status !== operation.http.status || boundary.bytes !== operation.http.bytes || boundary.sha256 !== operation.http.sha256 || !HASH.test(boundary.sha256)) gaps.push('independent HTTP client/server boundary mismatch or unavailable');
  if (scenario.workflow === 'local-screenshot') {
    if (dispatchRows.length || boundary?.requestId !== null || operation.http?.status !== 200 || !operation.screenshot || !boundary?.screenshot || JSON.stringify(operation.screenshot) !== JSON.stringify(boundary.screenshot) || !HASH.test(operation.screenshot.sha256) || !nonnegative(operation.screenshot.bytes) || !operation.screenshot.bytes) gaps.push('actual local screenshot unavailable; no Gateway round trip is credited');
    return { id: operation.id, toolId: operation.toolId, pass: gaps.length === 0, gaps, resultBoundary: 'local-only-screenshot', http: operation.http, screenshot: operation.screenshot };
  }
  const record = dispatchRows.length === 1 ? dispatchRows[0].record : null;
  if (!record || record.schemaVersion !== 2 || record.traceComplete !== true || record.evidenceErrors?.length !== 0 || boundary?.requestId !== record.requestId || record.toolId !== operation.toolId || record.binding?.projectId !== run.connection.gateway.projectId || record.binding?.relayInstanceId !== run.connection.relayInstanceId || record.binding?.relay?.packageHash !== run.packageBinding.packageHash || record.binding?.relay?.build !== run.packageBinding.version || record.binding?.relay?.creatorVersion !== run.identity.creatorVersion || record.inputSha256 !== operation.inputSha256) gaps.push('instrumented protected dispatch unavailable or binding mismatch');
  if (record) {
    if (record.outcome !== scenario.expectedOutcome) gaps.push('observed protected outcome differs from requested scenario');
    const c = record.creator; const g = record.gateway;
    if (!c || !['totalIpc', 'observationIpc', 'postGatewayIpc'].every(k => nonnegative(c[k])) || c.totalIpc !== c.observationIpc + c.postGatewayIpc) gaps.push('actual Creator IPC counters unavailable');
    if (!g || g.requests !== 1 || g.responses !== 1 || !nonnegative(g.responseBytes) || !g.responseBytes || !HASH.test(g.responseSha256 || '') || g.concurrent !== false) gaps.push('measured isolated Gateway HTTP response hash/count unavailable');
    const phases = record.phases || {}; const required = ['request-built', 'transport-send', 'transport-response'];
    if (record.outcome === 'completed') required.push('decision-verified', 'result-serialized');
    if (record.kind === 'execute') {
      required.push('execution-start', 'execution-finish');
      if (g?.requestsDuringExecution !== 0 || g?.responsesDuringExecution !== 0) gaps.push('Gateway traffic during Creator execution not proven absent');
    }
    const ordered = ['request-built', 'transport-send', 'transport-response', 'decision-verified', 'execution-start', 'execution-finish', 'result-serialized'].filter(k => Object.hasOwn(phases, k)).map(k => phases[k]);
    if (required.some(k => !Number.isFinite(phases[k])) || ordered.some((n, i) => n < 0 || (i && n < ordered[i - 1])) || !Number.isFinite(record.durationMs) || ordered.at(-1) - ordered[0] > record.durationMs + 0.001) gaps.push('monotonic phase transitions unavailable or invalid');
    if (!['execute', 'result', 'denied', 'failed'].includes(record.kind) || !['completed', 'denied', 'failed', 'outcome-unknown'].includes(record.outcome)) gaps.push('invalid protected kind/outcome');
    if (record.outcome !== 'completed' && (operation.http?.status !== 422 || operation.errorCode !== record.errorCode)) gaps.push('HTTP error boundary does not match observed protected error');
    if (record.kind !== 'execute' && ('execution-start' in phases || 'execution-finish' in phases || g?.requestsDuringExecution !== null || g?.responsesDuringExecution !== null)) gaps.push('nonexecution record falsely claims execution measurements');
    if (record.kind === 'denied' && (record.outcome !== 'denied' || c?.postGatewayIpc !== 0 || record.result !== null || operation.http?.status !== 422 || operation.errorCode !== record.errorCode)) gaps.push('denied zero post-Gateway IPC or HTTP error contract unavailable');
    if (record.kind === 'result' && c?.postGatewayIpc !== 0) gaps.push('finite result unexpectedly reached Creator IPC');
    if (scenario.workflow === 'large-result' && (!Number.isSafeInteger(scenario.minimumHttpBytes) || scenario.minimumHttpBytes < 65536 || operation.http?.bytes < scenario.minimumHttpBytes)) gaps.push('large independent HTTP result threshold not actually observed');
    if (record.outcome === 'completed' && (operation.http?.status !== 200 || !HASH.test(record.result?.sha256 || '') || !nonnegative(record.result?.bytes) || !record.result.bytes)) gaps.push('completed result not observed at both boundaries');
    if (scenario.workflow === 'ten-step' && record.executionCommandCount !== 10) gaps.push('ten executed commands not actually measured');
    if (scenario.workflow === 'mutation' && (record.kind !== 'execute' || !(c?.postGatewayIpc > 0))) gaps.push('actual mutation execution unavailable');
  }
  return { id: operation.id, toolId: operation.toolId, pass: gaps.length === 0, gaps, http: operation.http,
    observed: record ? { requestId: record.requestId, outcome: record.outcome, kind: record.kind, creator: record.creator, gateway: record.gateway, phases: record.phases, executionCommandCount: record.executionCommandCount, result: record.result } : null };
}
function verify(configPath) {
  const config = json(configPath); const run = json(config.runPath);
  if (run.schemaVersion !== 1 || run.evidenceScope !== 'installed-live' || run.resultBoundary !== 'independent-local-http-client' || run.runId !== config.runId || run.configSha256 !== sha(read(configPath)) || !Array.isArray(run.operations) || run.operations.length !== config.scenarios.length || new Set(run.operations.map(o => o.callId)).size !== run.operations.length) throw new Error('source fixture or invalid installed-live run');
  const { projectIdentity } = require('../dist/utcp/project-connection');
  const project = projectIdentity(config.projectPath);
  if (run.connection.projectPath !== project.projectPath || run.connection.projectId !== project.projectId || !Number.isInteger(run.connection.port) || !/^[0-9a-f-]{36}$/i.test(run.connection.relayInstanceId)) throw new Error('run selected a different canonical project/session');
  const packageBinding = installed(config);
  if (JSON.stringify(packageBinding) !== JSON.stringify(run.packageBinding) || run.identity.publicKeyDer !== config.devicePublicKeyDer || run.identity.runId !== run.runId || run.identity.packageHash !== packageBinding.packageHash || run.identity.targetPayloadHash !== packageBinding.targetPayloadHash) throw new Error('installed package changed or run identity mismatch');
  const signed = signedEvents(config.liveTracePath, run.identity, run.runId, packageBinding);
  if (signed.sha256 !== run.liveTraceSha256) throw new Error('signed live trace changed after independent run');
  const items = config.scenarios.map(scenario => {
    const matches = run.operations.filter(o => o.id === scenario.id && o.toolId === scenario.toolId);
    if (matches.length !== 1) throw new Error('scenario/operation mismatch');
    return creditOperation(matches[0], scenario, signed.events, run);
  });
  const gaps = [];
  const passed = s => items.some(i => i.id === s.id && i.pass);
  for (const workflow of ['read', 'mutation', 'ten-step', 'local-screenshot']) if (!config.scenarios.some(s => s.workflow === workflow && passed(s))) gaps.push('missing verified workflow: ' + workflow);
  if (!config.scenarios.some(s => s.expectedOutcome === 'denied' && passed(s))) gaps.push('missing verified denied zero IPC scenario');
  if (!items.every(i => i.pass)) gaps.push('one or more scenarios unverified');
  let surfaceReports = []; let canariesVerified = false;
  try {
    const surfaces = scan(config, [configPath, config.runPath, config.reportPath, config.liveTracePath, config.sourceTracePath, config.markersPath, config.surfacesPath].filter(Boolean));
    surfaceReports = surfaces.reports;
    const sources = { 'operation-input': 'inputs', 'creator-observation': 'observation', 'local-result': 'result' };
    for (const marker of surfaces.markers) {
      const observed = signed.events.filter(e => e.type === 'protected-dispatch' && e.record?.canarySources?.[sources[marker.sourceKind]]?.includes(marker.label));
      if (!observed.length || !observed.some(e => items.some(i => i.observed?.requestId === e.record.requestId && i.pass))) throw new Error('canary lacks real signed injection observation');
      if (!marker.allowedInGatewayRequest && signed.events.some(e => e.record?.request?.matchedMarkers?.includes(marker.label))) throw new Error('forbidden canary reached Gateway request');
    }
    canariesVerified = true;
  } catch (error) { gaps.push(error.code ? 'surface evidence filesystem unavailable' : error.message); }
  const telemetry = [];
  for (const event of signed.events.filter(e => e.type === 'protected-dispatch')) for (const completion of event.record.priorTelemetry || []) {
    const original = signed.events.find(e => e.type === 'protected-dispatch' && e.record.requestId === completion.requestId);
    if (original && original.record.outcome === completion.outcome && ['completed', 'failed', 'outcome-unknown'].includes(completion.outcome) && nonnegative(completion.durationMs) && completion.durationMs <= 300000) telemetry.push({ requestId: completion.requestId, outcome: completion.outcome, carrierRequestId: event.record.requestId });
    else gaps.push('completion telemetry contradicts measured outcome');
  }
  if (!telemetry.length) gaps.push('no observed next-request completion telemetry');
  const report = { schemaVersion: 1, evidenceScope: 'installed-live', qualificationStatus: gaps.length ? 'installed-live-partial' : 'installed-live-qualified', pass: gaps.length === 0, signedLiveAcceptance: gaps.length === 0,
    runId: run.runId, packageBinding, resultBoundary: 'independent-local-http-client-and-signed-server-response', items, surfaces: surfaceReports, canariesVerified, telemetry, gaps,
    limitations: ['Device signatures authenticate local instrumented records, not an independent hardware attestation of Creator.', 'Surface scans prove bytes of the supplied captured artifacts, not completeness of inaccessible databases, logs, or metrics.', 'Local screenshots are never represented as Gateway round trips; image bytes and raw protected payloads are not retained.', 'No unavailable counters are inferred zero. Source fixture reports cannot satisfy this verifier.'] };
  const output = JSON.stringify(report);
  if (config.markersPath && json(config.markersPath).some(m => output.includes(m.value))) throw new Error('report would retain canary material');
  write(config.reportPath, report); return report;
}
if (require.main === module) {
  try { const report = verify(process.env.CCB_INSTALLED_LIVE_CONFIG_PATH); console.log(JSON.stringify({ pass: report.pass, signedLiveAcceptance: report.signedLiveAcceptance, items: report.items.map(i => ({ id: i.id, pass: i.pass })), gaps: report.gaps })); if (!report.pass) process.exitCode = 2; }
  catch { console.error('installed-live verifier rejected evidence (unsigned/source-only, stale binding, unsafe artifact, or invalid contract)'); process.exitCode = 1; }
}
module.exports = { creditOperation, verify };
