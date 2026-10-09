'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { spawn } = require('node:child_process');
const { parseArgs, Watchdog, run } = require('../../scripts/ccp-watchdog');
const project = path.resolve('watchdog-project');

function healthy(overrides = {}) {
  return { instanceId: 'verified-instance', projectPath: project, projectMatches: true,
    probe: { status: 'responsive', sceneReady: true, code: null,
      evidence: { requestId: 'ready', startedAt: Date.now(), ageMs: 1, shared: false, settled: true } }, ...overrides };
}

async function server(t, handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/utcp`, project, instance: 'verified-instance', timeoutMs: 150, intervalMs: 1000 };
}

it('validates explicit binding and refuses unsafe or ambiguous arguments', () => {
  const required = ['--url', 'http://127.0.0.1:3000/utcp', '--project', project, '--instance', 'verified-instance'];
  assert.equal(parseArgs(required).timeoutMs, 2000);
  assert.equal(parseArgs([...required, '--once']).once, true);
  for (const extra of [['--timeout-ms', '0'], ['--timeout-ms', 'NaN'], ['--timeout-ms', '10001'], ['--interval-ms', '999'], ['--once', '--once'], ['--unknown'], ['--timeout-ms']]) {
    assert.throws(() => parseArgs([...required, ...extra]));
  }
  for (const url of ['https://127.0.0.1', 'http://example.com', 'http://127.0.0.1/tools/editorHandshake', 'http://user@127.0.0.1', 'http://127.0.0.1/?x=1']) {
    assert.throws(() => parseArgs(['--url', url, '--project', project, '--instance', 'verified-instance']));
  }
  assert.throws(() => parseArgs(required.slice(0, 4)));
  assert.throws(() => parseArgs(['--url', 'http://localhost', '--project', 'relative', '--instance', 'verified-instance']));
});

it('probes only the bound handshake and supports raw and enveloped replies', async t => {
  let reply = healthy();
  const options = await server(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(req.method, 'GET');
    assert.equal(url.pathname, '/tools/editorHandshake');
    assert.equal(url.searchParams.get('expectedProjectPath'), project);
    assert.ok(Number(url.searchParams.get('timeoutMs')) < options.timeoutMs);
    res.end(JSON.stringify(reply));
  });
  const watchdog = new Watchdog(options);
  const good = await watchdog.probe();
  assert.equal(good.state, 'Healthy');
  assert.equal(good.safeToMutate, true);
  assert.equal(good.requiresReadback, false);
  reply = { ok: true, tool: 'editorHandshake', data: healthy({ probe: { ...healthy().probe, sceneReady: false } }) };
  const notReady = await watchdog.probe();
  assert.equal(notReady.state, 'Healthy');
  assert.equal(notReady.reason, 'SCENE_NOT_READY');
  assert.equal(notReady.safeToMutate, false);
  assert.equal(notReady.requiresReadback, false);
});

it('absolute deadline terminates silent and trickling servers, with serial failure escalation', async t => {
  let trickle = false;
  const options = await server(t, (req, res) => {
    if (!trickle) return;
    res.writeHead(200);
    const timer = setInterval(() => res.write(' '), 15);
    res.on('close', () => clearInterval(timer));
  });
  const watchdog = new Watchdog(options);
  const started = performance.now();
  const first = watchdog.probe();
  await assert.rejects(watchdog.probe(), /already in flight/);
  assert.equal((await first).state, 'Degraded');
  trickle = true;
  assert.equal((await watchdog.probe()).state, 'Degraded');
  const third = await watchdog.probe();
  assert.equal(third.state, 'Unresponsive');
  assert.equal(third.reason, 'HTTP_DEADLINE');
  assert.equal(third.safeToMutate, false);
  assert.ok(performance.now() - started < 2000, 'activity must not extend the independent deadline');
});

it('identity mismatch remains unsafe even when the original identity returns', async t => {
  let reply = healthy({ instanceId: 'different-instance' });
  const options = await server(t, (req, res) => res.end(JSON.stringify(reply)));
  const watchdog = new Watchdog(options);
  assert.equal((await watchdog.probe()).reason, 'IDENTITY_MISMATCH_REBIND_REQUIRED');
  reply = healthy();
  for (let i = 0; i < 2; i++) {
    const status = await watchdog.probe();
    assert.equal(status.state, 'Degraded');
    assert.equal(status.safeToMutate, false);
    assert.equal(status.reason, 'IDENTITY_MISMATCH_REBIND_REQUIRED');
  }
  reply = healthy({ projectPath: path.resolve('wrong-project') });
  assert.equal((await new Watchdog(options).probe()).reason, 'IDENTITY_MISMATCH_REBIND_REQUIRED');
});

it('shared stuck evidence escalates by elapsed age, then requires two good replies and readback', async t => {
  let reply = healthy({ probe: { status: 'timeout', sceneReady: null, code: 'EDITOR_IPC_TIMEOUT',
    evidence: { requestId: 'stuck', startedAt: Date.now(), ageMs: 100, shared: true, settled: false } } });
  const options = await server(t, (req, res) => res.end(JSON.stringify(reply)));
  const watchdog = new Watchdog(options);
  for (let i = 0; i < 4; i++) assert.equal((await watchdog.probe()).state, 'Degraded');
  reply.probe.evidence.ageMs = 10000;
  assert.equal((await watchdog.probe()).state, 'Unresponsive');
  reply = healthy();
  const recovering = await watchdog.probe();
  assert.equal(recovering.state, 'Recovering');
  assert.equal(recovering.requiresReadback, true);
  assert.equal(recovering.safeToMutate, false);
  const recovered = await watchdog.probe();
  assert.equal(recovered.state, 'Healthy');
  assert.equal(recovered.requiresReadback, true);
  assert.equal(recovered.safeToMutate, false, 'recovery cannot acknowledge unknown mutation outcomes');
});

it('fails closed on oversized, legacy and unsettled responsive replies', async t => {
  let reply = 'x'.repeat(65537);
  const options = await server(t, (req, res) => res.end(reply));
  assert.equal((await new Watchdog(options).probe()).reason, 'HTTP_RESPONSE_TOO_LARGE');
  for (const probe of [{ status: 'responsive', sceneReady: true }, { ...healthy().probe, evidence: { ...healthy().probe.evidence, settled: false } }]) {
    reply = JSON.stringify(healthy({ probe }));
    const status = await new Watchdog(options).probe();
    assert.equal(status.reason, 'INVALID_PROBE');
    assert.equal(status.safeToMutate, false);
  }
});

it('slow replies degrade and independent IPC failures are not confused with repeated evidence', async t => {
  const options = await server(t, (req, res) => res.end(JSON.stringify(healthy())));
  const watchdog = new Watchdog(options);
  assert.equal(watchdog.observe(healthy(), 1001).reason, 'SLOW_RESPONSE');
  assert.equal(watchdog.observe(healthy(), 10).state, 'Recovering');
  assert.equal(watchdog.observe(healthy(), 10).state, 'Healthy');
  for (let i = 0; i < 3; i++) {
    const body = healthy({ probe: { status: 'error', sceneReady: null, code: 'EDITOR_IPC_ERROR',
      evidence: { requestId: String(i), startedAt: Date.now(), ageMs: 1, shared: false, settled: true } } });
    assert.equal(watchdog.observe(body, 1).state, i < 2 ? 'Degraded' : 'Unresponsive');
  }
});

it('aborting active polling closes the request without another probe or status', async t => {
  let requests = 0, close;
  const closed = new Promise(resolve => { close = resolve; });
  const controller = new AbortController();
  const options = await server(t, (req, res) => {
    requests++;
    res.on('close', close);
    controller.abort();
  });
  const statuses = [];
  await run(options, controller.signal, status => statuses.push(status));
  await Promise.race([closed, delay(1000).then(() => { throw new Error('aborted socket stayed open'); })]);
  assert.equal(requests, 1);
  assert.deepEqual(statuses, []);
});

it('CLI once prints one JSONL status and exits without persistent polling', async t => {
  const options = await server(t, (req, res) => res.end(JSON.stringify(healthy())));
  const child = spawn(process.execPath, [path.resolve('scripts/ccp-watchdog.js'), '--url', options.url,
    '--project', project, '--instance', options.instance, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).state, 'Healthy');
});
