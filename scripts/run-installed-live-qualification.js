'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { sha, read, json, write, installed } = require('./installed-live-qualification');
function request(port, url, method = 'GET', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (bytes && bytes.length > 1024 * 1024) return reject(new Error('HTTP input bound exceeded'));
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { ...headers, ...(bytes ? { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length } : {}) } }, res => {
      const chunks = []; let total = 0;
      res.on('data', chunk => { total += chunk.length; if (total > 8 * 1024 * 1024) res.destroy(new Error('HTTP result bound exceeded')); else chunks.push(chunk); });
      res.once('error', reject);
      res.once('aborted', () => reject(new Error('HTTP result aborted')));
      res.once('end', () => {
        if (!res.complete || res.headers.location || !String(res.headers['content-type']).startsWith('application/json')) return reject(new Error('invalid HTTP boundary'));
        const result = Buffer.concat(chunks, total);
        try { resolve({ status: res.statusCode, bytes: total, sha256: sha(result), value: JSON.parse(result.toString('utf8')) }); } catch { reject(new Error('HTTP result not valid JSON')); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('HTTP qualification timed out')));
    req.once('error', reject); req.end(bytes);
  });
}
function materialize(value, results) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.$result === 'string') {
    const [scenario, ...segments] = value.$result.split('/'); let selected = results.get(scenario);
    for (const segment of segments) { const key = segment.replace(/~1/g, '/').replace(/~0/g, '~'); if (!selected || !Object.hasOwn(selected, key)) throw new Error('scenario result reference unavailable'); selected = selected[key]; }
    if (selected === undefined) throw new Error('scenario result reference unavailable'); return selected;
  }
  if (Array.isArray(value)) return value.map(v => materialize(v, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materialize(v, results)]));
  return value;
}
async function run(configPath) {
  const config = json(configPath);
  if (config.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(config.runId) || !Array.isArray(config.scenarios) || !config.scenarios.length || config.scenarios.length > 256 || new Set(config.scenarios.map(s => s.id)).size !== config.scenarios.length) throw new Error('invalid installed-live config');
  if (typeof config.devicePublicKeyDer !== 'string') throw new Error('independently approved device public key is required');
  const packageBinding = installed(config);
  const { canonicalizeToBytes } = require('../dist/protected/canonical-json');
  const { projectIdentity, readConnectionState, assertConnectionConfig, ownerIsAlive } = require('../dist/utcp/project-connection');
  const selection = projectIdentity(config.projectPath);
  const state = readConnectionState(config.configPath); assertConnectionConfig(json(config.configPath), state);
  const connection = state.projects[selection.projectId];
  if (!connection || !connection.active || connection.projectPath !== selection.projectPath || !ownerIsAlive(connection.ownerPid) || !connection.gateway.origin || !connection.gateway.projectId) throw new Error('no active exact project/Gateway connection');
  const tokenEntries = new Map(read(connection.tokenPath, 4096).toString('utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => { const p = line.indexOf('='); return [line.slice(0, p), line.slice(p + 1)]; }));
  const prefix = `ccb3x_${connection.port}_`;
  const get = key => tokenEntries.get(prefix + key);
  if (get('CCB_RELAY_INSTANCE_ID') !== connection.relayInstanceId || get('CCB_BOUND_PORT') !== String(connection.port) || get('CCB_LOCAL_PROJECT_ID') !== selection.projectId || !get('CCB_LOCAL_TOKEN')) throw new Error('project token binding mismatch');
  const headers = { 'x-ccb-local-token': get('CCB_LOCAL_TOKEN'), 'x-ccb-relay-instance': connection.relayInstanceId, 'x-ccb-bound-port': String(connection.port), 'x-ccb-project-id': selection.projectId };
  const remote = await request(connection.port, '/connection');
  if (remote.status !== 200 || remote.value.projectPath !== selection.projectPath || remote.value.projectId !== selection.projectId || remote.value.port !== connection.port || remote.value.relayInstanceId !== connection.relayInstanceId || JSON.stringify(remote.value.gateway) !== JSON.stringify(connection.gateway)) throw new Error('HTTP project connection identity mismatch');
  const identity = (await request(connection.port, '/qualification/identity', 'GET', headers)).value;
  if (identity.runId !== config.runId || identity.packageHash !== packageBinding.packageHash || identity.targetPayloadHash !== packageBinding.targetPayloadHash || identity.publicKeyDer !== config.devicePublicKeyDer || identity.build.version !== packageBinding.version || ['commit', 'builtAt', 'branch', 'dirty'].some(k => identity.build[k] !== packageBinding.build[k])) throw new Error('installed runtime/run/build identity mismatch');
  const manual = await request(connection.port, '/utcp');
  if (manual.status !== 200 || !Array.isArray(manual.value.tools)) throw new Error('live HTTP manual unavailable');
  const results = new Map(); const operations = [];
  for (const scenario of config.scenarios) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(scenario.id) || !['completed', 'denied', 'failed', 'outcome-unknown'].includes(scenario.expectedOutcome)) throw new Error('invalid scenario ID/outcome');
    const tool = manual.value.tools.find(t => t.name === scenario.toolId);
    if (!tool) throw new Error('scenario tool is not exposed');
    const target = new URL(tool.tool_call_template.url);
    if (target.origin !== `http://localhost:${connection.port}` || target.search || target.hash) throw new Error('tool manual escaped selected connection');
    const inputs = materialize(scenario.inputs || {}, results); const callId = crypto.randomUUID();
    const method = tool.tool_call_template.http_method;
    let url = target.pathname;
    if (method === 'GET') {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(inputs)) query.set(k, v === null ? '__null__' : typeof v === 'object' ? JSON.stringify(v) : String(v));
      url += '?' + query;
    }
    const started = Date.now();
    try {
      const result = await request(connection.port, url, method, { ...headers, 'x-ccb-qualification-call': callId, 'x-ccb-qualification-run': config.runId,
        ...((scenario.workflow === 'mutation' || scenario.workflow === 'ten-step' || scenario.expectedOutcome === 'denied' || scenario.idempotencyKey) ? { 'x-ccb-idempotency-key': scenario.idempotencyKey || crypto.randomUUID() } : {}) }, method === 'GET' ? undefined : inputs);
      results.set(scenario.id, result.value);
      let screenshot = null;
      if (scenario.workflow === 'local-screenshot') {
        const v = result.value?.tool === scenario.toolId && result.value?.data ? result.value.data : result.value;
        if (result.status === 200 && v?.type === 'image' && typeof v.data === 'string' && ['image/jpeg', 'image/png'].includes(v.mimeType)) {
          const image = Buffer.from(v.data, 'base64');
          const valid = v.mimeType === 'image/png' ? image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : image[0] === 255 && image[1] === 216 && image.at(-2) === 255 && image.at(-1) === 217;
          if (valid) screenshot = { bytes: image.length, sha256: sha(image), mimeType: v.mimeType };
        }
      }
      operations.push({ id: scenario.id, toolId: scenario.toolId, callId, method, startedAt: started, finishedAt: Date.now(), inputSha256: sha(canonicalizeToBytes(inputs)), http: { status: result.status, bytes: result.bytes, sha256: result.sha256 }, errorCode: result.status >= 400 && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.value?.code) ? result.value.code : null, screenshot });
    } catch { operations.push({ id: scenario.id, toolId: scenario.toolId, callId, method, startedAt: started, finishedAt: Date.now(), http: null, transportError: 'HTTP boundary unavailable', screenshot: null }); }
  }
  const finalConnection = await request(connection.port, '/connection');
  if (JSON.stringify(finalConnection.value) !== JSON.stringify(remote.value)) throw new Error('connection changed during qualification');
  const runArtifact = { schemaVersion: 1, evidenceScope: 'installed-live', resultBoundary: 'independent-local-http-client', runId: config.runId, configSha256: sha(read(configPath)), packageBinding, identity, connection: { ...remote.value, ownerPid: connection.ownerPid }, operations, liveTraceSha256: sha(read(config.liveTracePath)) };
  write(config.runPath, runArtifact);
  return { operations: operations.length, httpResults: operations.filter(o => o.http).length, signedLiveAcceptance: false };
}
if (require.main === module) run(process.env.CCB_INSTALLED_LIVE_CONFIG_PATH).then(r => console.log(JSON.stringify(r))).catch(() => { console.error('installed-live runner failed; check explicit config, trusted installed package, project connection, and qualification opt-in'); process.exitCode = 1; });
module.exports = { request, materialize, run };
