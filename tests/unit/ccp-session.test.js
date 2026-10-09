'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');
const { parseArgs, requestHeartbeat, run } = require('../../scripts/session-presence/heartbeat');
const project = path.resolve('session-project');

function identity(overrides = {}) {
  return { instanceId: 'verified-instance', projectPath: project, projectMatches: true, ...overrides };
}
function accepted(body) {
  return { sessionId: body.sessionId, label: body.label, transport: body.transport,
    lastSeen: Date.now(), ageMs: 0, status: body.operation === 'close' ? 'Expired' : 'Active' };
}
async function server(t, handler) {
  const sockets = new Set();
  const listener = http.createServer((req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => handler(req, res, text ? JSON.parse(text) : null));
  });
  listener.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); listener.close(resolve); }));
  return { url: `http://127.0.0.1:${listener.address().port}`, project, instance: 'verified-instance', session: 'unique-session', label: 'HTTP helper', intervalMs: 1000 };
}

it('requires explicit safe binding and a unique bounded session ID', () => {
  const args = ['--url', 'http://localhost:3000/utcp', '--project', project, '--instance', 'verified-instance', '--session', 'unique-session'];
  const options = parseArgs(args);
  assert.equal(options.url, 'http://127.0.0.1:3000');
  assert.equal(options.timeoutMs, 2000);
  assert.equal(options.intervalMs, 5000);
  for (const extra of [['--transport', 'code-mode'], ['--session', 'duplicate'], ['--label', ''], ['--label', ' padded '], ['--interval-ms', '999'], ['--timeout-ms', '10000'], ['--once', '--once']]) {
    assert.throws(() => parseArgs([...args, ...extra]));
  }
  assert.throws(() => parseArgs(args.slice(0, -2)));
  assert.throws(() => parseArgs([...args, '--interval-ms', '10001']), /interval/);
  assert.equal(parseArgs([...args, '--interval-ms', '10000']).intervalMs, 10000);
  assert.throws(() => parseArgs([...args.slice(0, -1), 'x'.repeat(129)]));
  for (const url of ['https://127.0.0.1', 'http://example.com', 'http://user@localhost', 'http://localhost/?x=1']) {
    assert.throws(() => parseArgs(['--url', url, ...args.slice(2)]));
  }
  assert.throws(() => parseArgs(['--url', options.url, '--project', 'relative', ...args.slice(4)]));
});

it('rejects PID-only lifecycle ownership at the CLI boundary', () => {
  const cli=require('../../scripts/session-presence/cli');
  assert.throws(() => cli.parseArgs(['--registry','r','--project',project,'--session','s','--parent-pid','123']), /Unknown/);
});

it('rejects unsupported IPv6 loopback bindings', () => {
  assert.throws(() => parseArgs(['--url','http://[::1]:3000/utcp','--project',project,'--instance','verified-instance','--session','s']), /IPv4 loopback/);
});

it('refuses both wrong instance and wrong project without sending any heartbeat', async t => {
  let reply = identity({ instanceId: 'wrong-instance' }), posts = 0;
  const options = await server(t, (req, res) => {
    if (req.method === 'POST') posts++;
    res.end(JSON.stringify(reply));
  });
  for (const mismatch of [{ instanceId: 'wrong-instance' }, { projectPath: path.resolve('other-project') }, { projectMatches: false }]) {
    reply = identity(mismatch);
    await assert.rejects(run({ ...options, once: true }, undefined, () => {}), /IDENTITY_MISMATCH/);
  }
  assert.equal(posts, 0);
});

it('revalidates every cycle, emits only transitions, and closes on cancellation', async t => {
  const controller = new AbortController(), events = [], requests = [];
  let beats = 0;
  const options = await server(t, (req, res, body) => {
    requests.push(body?.operation ?? 'handshake');
    if (!body) {
      const url = new URL(req.url, options.url);
      assert.equal(url.pathname, '/tools/editorHandshake');
      assert.equal(url.searchParams.get('expectedProjectPath'), project);
      res.end(JSON.stringify(identity()));
    } else {
      assert.equal(req.url, '/tools/editorSessionHeartbeat');
      assert.equal(body.transport, 'http-helper');
      assert.equal(body.expectedInstanceId, options.instance);
      res.end(JSON.stringify({ ok: true, tool: 'editorSessionHeartbeat', data: accepted(body) }));
      if (body.operation === 'beat' && ++beats === 2) setImmediate(() => controller.abort());
    }
  });
  await run(options, controller.signal, status => events.push(status));
  assert.deepEqual(requests, ['handshake', 'beat', 'handshake', 'beat', 'close']);
  assert.deepEqual(events.map(event => event.state), ['Active', 'Stopped']);
  assert.equal(events[0].label, 'HTTP helper');
  assert.equal(events[0].transport, 'http-helper');
});

it('stops instead of rebinding after a later identity change', async t => {
  let handshakes = 0;
  const operations = [];
  const options = await server(t, (req, res, body) => {
    if (body) { operations.push(body.operation); res.end(JSON.stringify(accepted(body))); }
    else res.end(JSON.stringify(identity(++handshakes === 1 ? {} : { instanceId: 'replacement-instance' })));
  });
  await assert.rejects(run(options, undefined, () => {}), /IDENTITY_MISMATCH/);
  assert.deepEqual(operations, ['beat']);
});

it('rejects malformed, oversized, wrong-route and false success acknowledgements', async t => {
  let reply;
  const options = await server(t, (req, res) => res.end(reply));
  for (const body of ['not json', '{}', 'x'.repeat(65537), JSON.stringify({ ok: true, tool: 'editorHandshake', data: {} }),
    JSON.stringify(accepted({ sessionId: 'different-session', label: options.label, transport: 'http-helper' }))]) {
    reply = body;
    await assert.rejects(requestHeartbeat(options, 'beat'));
  }
});

it('bounds trickling responses by absolute deadline and aborts an in-flight beat before close', async t => {
  let mode = 'trickle';
  const controller = new AbortController(), operations = [];
  const options = await server(t, (req, res, body) => {
    if (!body) return res.end(JSON.stringify(identity()));
    operations.push(body.operation);
    if (body.operation === 'close') return res.end(JSON.stringify(accepted(body)));
    if (mode === 'abort') { controller.abort(); return; }
    res.writeHead(200);
    const timer = setInterval(() => res.write(' '), 20);
    res.on('close', () => clearInterval(timer));
  });
  const started = performance.now();
  await assert.rejects(requestHeartbeat(options, 'beat'), /HTTP_DEADLINE/);
  assert.ok(performance.now() - started < 3500);
  mode = 'abort';
  await run(options, controller.signal, () => {});
  assert.deepEqual(operations, ['beat', 'beat', 'close']);
});

it('persistent transport failures stop after three spaced attempts without reporting active', async t => {
  let requests = 0;
  const events = [];
  const options = await server(t, (req, res) => { requests++; res.writeHead(503); res.end(); });
  const started = performance.now();
  await assert.rejects(run(options, undefined, status => events.push(status)), /HTTP_STATUS_503/);
  assert.equal(requests, 3);
  assert.ok(performance.now() - started >= 1900, 'failed cycles must not tight-loop');
  assert.deepEqual(events.map(event => event.state), ['Error', 'Stopped']);
});
