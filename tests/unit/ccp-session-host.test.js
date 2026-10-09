'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SessionLifecycleHost } = require('../../scripts/session-presence/host');
const ompFactory = require('../../.omp/extensions/ccp-session').default;
const project = path.resolve('session-project');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function supervisors() {
  const entries = [], operations = [], live = new Set();
  const factory = options => {
    const lifetime = deferred();
    const entry = { options, lifetime, stopGate: null, stopping: deferred() };
    entries.push(entry);
    return {
      start() {
        assert.equal(live.size, 0, 'a previous supervisor must close before a replacement opens');
        live.add(options.session);
        operations.push(['open', options.session]);
        options.emit({ state: 'Active', reason: 'HTTP_HELPER_HEARTBEAT_ACCEPTED' });
        return lifetime.promise;
      },
      async stop() {
        operations.push(['closing', options.session]);
        entry.stopping.resolve();
        if (entry.stopGate) await entry.stopGate.promise;
        live.delete(options.session);
        operations.push(['close', options.session]);
        lifetime.resolve();
      },
    };
  };
  return { factory, entries, operations, live };
}

it('returns from startup before lifetime settles, deduplicates, and isolates concurrent runtimes', async () => {
  const first = supervisors(), second = supervisors();
  const a = new SessionLifecycleHost({ project, supervisorFactory: first.factory });
  const b = new SessionLifecycleHost({ project, supervisorFactory: second.factory });
  try {
    const opening = a.switchSession({ sessionId: 'same-chat' });
    assert.equal(a.switchSession({ sessionId: 'same-chat' }), opening);
    const id = await opening;
    assert.equal(await a.switchSession({ sessionId: 'same-chat' }), id);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.notEqual(await b.switchSession({ sessionId: 'same-chat' }), id);
    assert.equal(first.entries.length, 1);
    assert.equal(first.live.has(id), true);
  } finally { await Promise.all([a.shutdown(), b.shutdown()]); }
});

it('serializes replacements and coalesces obsolete pending logical sessions', async () => {
  const fake = supervisors(), host = new SessionLifecycleHost({ project, supervisorFactory: fake.factory });
  try {
    const original = await host.switchSession({ sessionId: 'a' });
    const gate = deferred();
    fake.entries[0].stopGate = gate;
    const obsolete = host.switchSession({ sessionId: 'b' });
    await fake.entries[0].stopping.promise;
    const replacement = host.switchSession({ sessionId: 'c' });
    assert.deepEqual([...fake.live], [original]);
    assert.equal(fake.entries.length, 1);
    gate.resolve();
    assert.equal(await obsolete, null);
    const current = await replacement;
    assert.notEqual(current, original);
    assert.deepEqual(fake.operations.map(([operation]) => operation), ['open', 'closing', 'close', 'open']);
    assert.deepEqual([...fake.live], [current]);
  } finally { await host.shutdown(); }
});

it('shutdown is terminal while a switch is closing and forbids all late startups', async () => {
  const fake = supervisors(), statuses = [];
  const host = new SessionLifecycleHost({ project, supervisorFactory: fake.factory, emit: status => statuses.push(status) });
  await host.switchSession({ sessionId: 'a' });
  const gate = deferred();
  fake.entries[0].stopGate = gate;
  const switching = host.switchSession({ sessionId: 'b' });
  await fake.entries[0].stopping.promise;
  const shutdown = host.shutdown();
  assert.equal(host.shutdown(), shutdown);
  assert.equal(await host.switchSession({ sessionId: 'late' }), null);
  gate.resolve();
  await Promise.all([switching, shutdown]);
  fake.entries[0].options.emit({ state: 'Active', reason: 'LATE_HEARTBEAT' });
  assert.equal(fake.entries.length, 1);
  assert.equal(fake.live.size, 0);
  assert.deepEqual(statuses.at(-1), { state: 'Stopped', reason: 'HOST_SHUTDOWN', sessionId: null });
});

it('shutdown cancels a launch that has not reached the queue yet', async () => {
  const fake = supervisors(), host = new SessionLifecycleHost({ project, supervisorFactory: fake.factory });
  const launch = host.switchSession({ sessionId: 'never-opened' });
  await host.shutdown();
  assert.equal(await launch, null);
  assert.equal(fake.entries.length, 0);
});

it('contains lifetime rejection and bounds untrusted status without leaking raw errors', async () => {
  const fake = supervisors(), statuses = [], reported = deferred();
  const host = new SessionLifecycleHost({ project, supervisorFactory: fake.factory, emit: status => {
    statuses.push(status);
    if (status.state === 'Error') reported.resolve();
    throw new Error('a broken UI must not kill a background session');
  } });
  try {
    const id = await host.switchSession({ sessionId: 'a' });
    fake.entries[0].options.emit({ state: 'Degraded', reason: '\u001b[31msecret'.repeat(100) });
    assert.deepEqual(statuses.at(-1), { state: 'Degraded', reason: 'SESSION_HELPER_FAILED', sessionId: id });
    fake.entries[0].lifetime.reject(Object.assign(new Error('sensitive URL'), { code: 'HTTP_DEADLINE' }));
    await reported.promise;
    assert.deepEqual(statuses.at(-1), { state: 'Error', reason: 'HTTP_DEADLINE', sessionId: id });
  } finally { await host.shutdown(); }
});

it('refuses a replacement when closing fails rather than overlapping lifetimes', async () => {
  const fake = supervisors(), host = new SessionLifecycleHost({ project, supervisorFactory: fake.factory });
  const original = await host.switchSession({ sessionId: 'a' });
  const gate = deferred();
  fake.entries[0].stopGate = gate;
  const replacement = host.switchSession({ sessionId: 'b' });
  await fake.entries[0].stopping.promise;
  gate.reject(Object.assign(new Error('close failed'), { code: 'CLOSE_FAILED' }));
  await assert.rejects(replacement, /close failed/);
  assert.equal(fake.entries.length, 1);
  assert.deepEqual([...fake.live], [original]);
  fake.entries[0].stopGate = null;
  await host.shutdown();
  assert.equal(fake.live.size, 0);
});

it('rejects missing logical IDs and nonabsolute projects before creating any supervisor', async () => {
  const fake = supervisors(), host = new SessionLifecycleHost({ supervisorFactory: fake.factory });
  await assert.rejects(host.switchSession({ project }), { code: 'INVALID_SESSION' });
  await assert.rejects(host.switchSession({ sessionId: 'a', project: 'relative' }), { code: 'INVALID_PROJECT' });
  assert.equal(fake.entries.length, 0);
  await host.shutdown();
});

function ompHarness(env) {
  const handlers = new Map(), fake = supervisors(), ui = [], log = [];
  const forbidden = () => { throw new Error('model context writes are forbidden'); };
  ompFactory({ on: (event, handler) => handlers.set(event, handler), logger: { info: text => log.push(text) },
    sendMessage: forbidden, sendUserMessage: forbidden, appendEntry: forbidden }, { env, supervisorFactory: fake.factory });
  const context = (id, cwd = project, hasUI = true) => ({ cwd, hasUI, sessionManager: { getSessionId: () => id },
    ui: { setStatus: (key, text) => ui.push({ key, text }) } });
  const fire = async (event, ctx) => { await handlers.get(event)?.({ type: event }, ctx); };
  return { fake, ui, log, context, fire };
}

it('OMP uses session lifecycle rather than agent idle, and branches close before opening', async () => {
  const app = ompHarness({}), ctx = app.context('a');
  await app.fire('session_start', ctx);
  const first = app.fake.entries[0].options.session;
  await app.fire('agent_end', ctx);
  await app.fire('session_start', ctx);
  assert.deepEqual([...app.fake.live], [first]);
  await app.fire('session_branch', app.context('branch'));
  assert.equal(app.fake.entries.length, 2);
  assert.notEqual(app.fake.entries[1].options.session, first);
  assert.deepEqual(app.fake.operations.map(([operation]) => operation), ['open', 'closing', 'close', 'open']);
  assert.equal(app.fake.entries[1].options.project, project);
  assert.ok(app.ui.some(({ text }) => text === 'CCP Active: HTTP_HELPER_HEARTBEAT_ACCEPTED'));
  await app.fire('session_shutdown', ctx);
  await app.fire('session_switch', app.context('late'));
  assert.equal(app.fake.live.size, 0);
  assert.equal(app.fake.entries.length, 2);
});

it('OMP honors explicit target and registry, supports headless status, and fails closed on invalid target', async () => {
  const target = path.resolve('configured-project'), registry = path.resolve('custom-registry.json');
  const app = ompHarness({ CCP_SESSION_PROJECT: target, CCP_SESSION_REGISTRY: registry, CCP_SESSION_NAMESPACE: 'ccp3x_3000' });
  const ctx = app.context('a', path.resolve('other-workspace'), false);
  await app.fire('session_start', ctx);
  assert.equal(app.fake.entries[0].options.project, target);
  assert.equal(app.fake.entries[0].options.registryPath, registry);
  app.fake.entries[0].options.emit({ state: 'Closed', reason: 'HTTP_HELPER_CLOSE_UNCONFIRMED' });
  assert.equal(app.log.at(-1), 'CCP Closed: HTTP_HELPER_CLOSE_UNCONFIRMED');
  assert.equal(app.fake.entries[0].options.namespace, 'ccp3x_3000');
  assert.ok(app.log.includes('CCP Active: HTTP_HELPER_HEARTBEAT_ACCEPTED'));
  await app.fire('session_shutdown', ctx);
  const invalidApp = ompHarness({ CCP_SESSION_PROJECT: 'relative' });
  await invalidApp.fire('session_start', invalidApp.context('a'));
  assert.equal(invalidApp.fake.entries.length, 0);
  assert.equal(invalidApp.ui.at(-1).text, 'CCP Error: INVALID_PROJECT');
  await invalidApp.fire('session_shutdown', invalidApp.context('a'));
});
