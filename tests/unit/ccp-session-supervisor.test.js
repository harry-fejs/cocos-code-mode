'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { requireDist } = require('../helpers/require-dist');
const { SessionPresenceStore } = requireDist('utcp/session-presence.js');
const { SessionLifecycleSupervisor, discoverBinding } = require('../../scripts/session-presence/supervisor');
const project = path.resolve('supervisor-project');
const otherProject = path.resolve('other-supervisor-project');

async function bounded(promise, ms = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Operation did not settle within ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function eventually(predicate, message, ms = 3500) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-supervisor-'));
  const registryPath = path.join(directory, 'registry.json');
  const editors = [], supervisors = [];
  t.after(async () => {
    for (const editor of editors) editor.releaseClose();
    try { await bounded(Promise.all(supervisors.map(supervisor => supervisor.stop()))); }
    finally {
      await Promise.all(editors.map(editor => new Promise(resolve => {
        for (const socket of editor.sockets) socket.destroy();
        editor.listener.close(resolve);
      })));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    registryPath,
    registry(...entries) {
      fs.writeFileSync(registryPath, JSON.stringify({ manual_call_templates: entries.map(editor => ({
        name: editor.namespace, url: `${editor.url}/utcp`,
      })) }));
    },
    supervisor(session, options = {}) {
      const supervisor = new SessionLifecycleSupervisor({ project, session, registryPath,
        intervalMs: 1000, retryMs: 100, emit: () => {}, ...options });
      supervisors.push(supervisor);
      return supervisor;
    },
    async editor(instance, editorProject = project) {
      const editor = { instance, project: editorProject, store: new SessionPresenceStore(instance),
        writes: [], handshakes: 0, holdHandshake: false, holdClose: false, pendingCloses: [], sockets: new Set() };
      editor.releaseClose = () => { editor.holdClose = false; for (const finish of editor.pendingCloses.splice(0)) finish(); };
      editor.listener = http.createServer((req, res) => {
        const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/tools/editorHandshake') {
          editor.handshakes++;
          if (editor.holdHandshake) return;
          const expected = new URL(req.url, 'http://localhost').searchParams.get('expectedProjectPath');
          return reply(200, { instanceId: editor.instance, projectPath: editor.project,
            projectMatches: editor.claimProjectMatch ?? (expected === editor.project) });
        }
        if (req.method !== 'POST' || req.url !== '/tools/editorSessionHeartbeat') return reply(404, { error: 'Not found' });
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
          try {
            const input = JSON.parse(raw);
            editor.writes.push(input);
            const finish = () => {
              try { reply(200, { ok: true, tool: 'editorSessionHeartbeat', data: editor.store.heartbeat(input) }); }
              catch (error) { reply(error.status || 500, { error: error.code || error.message }); }
            };
            if (input.operation === 'close' && editor.holdClose) editor.pendingCloses.push(finish);
            else finish();
          } catch (error) { reply(400, { error: error.message }); }
        });
      });
      editor.listener.on('connection', socket => {
        editor.sockets.add(socket);
        socket.on('close', () => editor.sockets.delete(socket));
      });
      editors.push(editor);
      await new Promise((resolve, reject) => {
        editor.listener.once('error', reject);
        editor.listener.listen(0, '127.0.0.1', resolve);
      });
      editor.url = `http://127.0.0.1:${editor.listener.address().port}`;
      editor.namespace = `ccp3x_${editor.listener.address().port}`;
      return editor;
    },
  };
}

it('notices registry replacement while the old editor stays healthy', { timeout: 10000 }, async t => {
  const h = harness(t), old = await h.editor('healthy-old'), replacement = await h.editor('healthy-new');
  h.registry(old);
  const supervisor = h.supervisor('registry-change');
  supervisor.start();
  await eventually(() => old.store.snapshot().length === 1, 'old editor receives presence');
  h.registry(replacement);
  await eventually(() => replacement.store.snapshot().length === 1, 'registry change triggers replacement');
  const count = old.writes.length;
  await delay(1100);
  assert.equal(old.writes.length, count, 'removed binding no longer receives beats');
  await supervisor.stop();
});

it('rejects shutdown when close is not acknowledged', async () => {
  const supervisor = new SessionLifecycleSupervisor({ project, session: 'unconfirmed-close',
    binding: {url:'http://127.0.0.1:12345',instance:'test',project},
    runSession: async (_options, signal, emit) => {
      await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true}));
      emit({state:'Stopped',reason:'CLOSE_UNCONFIRMED_HTTP_DEADLINE'});
    } });
  supervisor.start();
  await delay(10);
  await assert.rejects(supervisor.stop(), error => error.code === 'CLOSE_UNCONFIRMED');
});

it('keeps two sessions independent, starts each helper once, and closes only the stopped session', { timeout: 10000 }, async t => {
  const h = harness(t), editor = await h.editor('shared-editor');
  h.registry(editor);
  const first = h.supervisor('session-first'), second = h.supervisor('session-second');
  const firstLife = first.start(), secondLife = second.start();
  assert.equal(first.start(), firstLife);
  assert.equal(first.start(), firstLife);
  assert.equal(second.start(), secondLife);
  await eventually(() => editor.store.snapshot().length === 2, 'both independent sessions should become present');
  assert.deepEqual(editor.store.snapshot().map(row => row.sessionId).sort(), ['session-first', 'session-second']);
  await bounded(first.stop());
  const firstBeats = editor.writes.filter(input => input.sessionId === 'session-first' && input.operation === 'beat').length;
  await bounded(firstLife);
  assert.deepEqual(editor.store.snapshot().map(row => row.sessionId), ['session-second']);
  await eventually(() => editor.writes.filter(input => input.sessionId === 'session-second' && input.operation === 'beat').length >= 2,
    'remaining session must keep heartbeating while its peer is closed');
  assert.equal(editor.writes.filter(input => input.sessionId === 'session-first' && input.operation === 'close').length, 1);
  assert.equal(editor.writes.filter(input => input.sessionId === 'session-first' && input.operation === 'beat').length, firstBeats);
  await bounded(second.stop());
  await bounded(secondLife);
  assert.deepEqual(editor.store.snapshot(), []);
});

it('refuses ambiguous discovery until an explicit namespace selects the editor', { timeout: 10000 }, async t => {
  const h = harness(t), first = await h.editor('editor-first'), second = await h.editor('editor-second');
  h.registry(first, second);
  await assert.rejects(discoverBinding({ registryPath: h.registryPath, project }), error => error.code === 'BINDING_AMBIGUOUS');
  const events = [];
  const supervisor = h.supervisor('ambiguous-session', { emit: event => events.push(event) });
  supervisor.start();
  await eventually(() => events.some(event => event.state === 'Blocked'), 'ambiguous discovery must block binding');
  await supervisor.stop();
  assert.deepEqual(first.writes, []);
  assert.deepEqual(second.writes, []);
  const binding = await discoverBinding({ registryPath: h.registryPath, project, namespace: second.namespace });
  assert.equal(binding.instance, 'editor-second');
  assert.equal(binding.url, second.url);
});

it('refuses a wrong project even when the server falsely claims projectMatches', { timeout: 10000 }, async t => {
  const h = harness(t), wrong = await h.editor('wrong-editor', otherProject);
  wrong.claimProjectMatch = true;
  h.registry(wrong);
  await assert.rejects(discoverBinding({ registryPath: h.registryPath, project }), error => error.code === 'BINDING_UNAVAILABLE');
  const events = [];
  const supervisor = h.supervisor('wrong-project-session', { binding: { url: wrong.url, instance: wrong.instance, project },
    emit: event => events.push(event) });
  supervisor.start();
  await eventually(() => events.some(event => event.reason === 'IDENTITY_MISMATCH_REBIND_REQUIRED'), 'explicit binding must still verify project identity');
  await supervisor.stop();
  assert.deepEqual(wrong.writes, []);
  assert.deepEqual(wrong.store.snapshot(), []);
});

it('re-discovers a new instance and port without writing to the editor that replaced the old identity', { timeout: 10000 }, async t => {
  const h = harness(t), old = await h.editor('original-editor'), replacement = await h.editor('replacement-editor');
  const wrong = await h.editor('unrelated-editor', otherProject);
  h.registry(old);
  const supervisor = h.supervisor('rebind-session');
  supervisor.start();
  await eventually(() => old.store.snapshot().some(row => row.sessionId === 'rebind-session'), 'original session should become active');
  const oldWrites = old.writes.length;
  old.instance = 'editor-now-on-old-port';
  old.project = otherProject;
  old.store = new SessionPresenceStore(old.instance);
  h.registry(wrong, replacement);
  await eventually(() => replacement.store.snapshot().some(row => row.sessionId === 'rebind-session'), 'session should rebind to the verified replacement');
  assert.equal(old.writes.length, oldWrites, 'neither beat nor close may target the changed editor');
  assert.deepEqual(wrong.writes, []);
  await supervisor.stop();
  assert.deepEqual(replacement.store.snapshot(), []);
  assert.equal(replacement.writes.filter(input => input.operation === 'close').length, 1);
});

it('rebinds to a new verified instance on the same port without closing the replacement with stale identity', { timeout: 10000 }, async t => {
  const h = harness(t), editor = await h.editor('same-port-original');
  h.registry(editor);
  const supervisor = h.supervisor('same-port-session');
  supervisor.start();
  await eventually(() => editor.store.snapshot().length === 1, 'original instance should become active');
  const beforeReplacement = editor.writes.length;
  editor.instance = 'same-port-replacement';
  editor.store = new SessionPresenceStore(editor.instance);
  await eventually(() => editor.store.snapshot().some(row => row.sessionId === 'same-port-session'), 'new instance should receive the rebound session');
  await supervisor.stop();
  assert.deepEqual(editor.store.snapshot(), []);
  assert.ok(editor.writes.slice(beforeReplacement).every(input => input.expectedInstanceId === editor.instance),
    'the old identity must not be used for beats or closes after replacement');
  assert.equal(editor.writes.filter(input => input.operation === 'close').length, 1);
});

it('aborts in-flight discovery and shuts down without waiting for the HTTP deadline', { timeout: 10000 }, async t => {
  const h = harness(t), editor = await h.editor('unresponsive-editor');
  editor.holdHandshake = true;
  h.registry(editor);
  const abort = new AbortController();
  const discovering = discoverBinding({ registryPath: h.registryPath, project, signal: abort.signal });
  const rejection = assert.rejects(discovering, error => error.code === 'ABORTED');
  await eventually(() => editor.handshakes === 1, 'discovery request should reach the listener');
  abort.abort();
  await bounded(rejection, 1000);
  const supervisor = h.supervisor('aborted-discovery-session');
  const lifetime = supervisor.start();
  await eventually(() => editor.handshakes === 2, 'supervisor discovery should reach the listener');
  await bounded(supervisor.stop(), 1000);
  await bounded(lifetime, 1000);
  assert.deepEqual(editor.writes, []);
});

it('awaits the close acknowledgement and cannot start another helper while closing', { timeout: 10000 }, async t => {
  const h = harness(t), editor = await h.editor('closing-editor');
  h.registry(editor);
  const supervisor = h.supervisor('closing-session');
  const lifetime = supervisor.start();
  await eventually(() => editor.store.snapshot().length === 1, 'session should become active');
  editor.holdClose = true;
  let stopped = false;
  const stopping = supervisor.stop().then(() => { stopped = true; });
  await eventually(() => editor.pendingCloses.length === 1, 'close should reach the listener');
  supervisor.start();
  await delay(150);
  assert.equal(stopped, false, 'stop must not resolve while its close is in flight');
  assert.deepEqual(editor.writes.map(input => input.operation), ['beat', 'close']);
  editor.releaseClose();
  await bounded(stopping);
  await bounded(lifetime);
  await supervisor.stop();
  assert.deepEqual(editor.store.snapshot(), []);
  assert.deepEqual(editor.writes.map(input => input.operation), ['beat', 'close']);
});
