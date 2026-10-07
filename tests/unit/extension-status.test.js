'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');
const { inspectExtensionStatus } = requireDist('extension-status.js');
const { UtcpServerManager, setServerProfile } = requireDist('utcp/utcp-server.js');

it('status verifies actual HTTP identity, registry ownership and scene readiness independently', async () => {
  const original = global.Editor;
  global.Editor = { Project: { path: process.cwd() }, App: { version: '3.7.3' }, Message: { request: async () => false } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-status-'));
  const registry = path.join(dir, 'registry.json');
  const server = new UtcpServerManager();
  try {
    const stopped = await inspectExtensionStatus(null, registry);
    assert.equal(stopped.server.running, false);
    assert.equal(stopped.http.status, 'not-running');
    const port = await server.start();
    const identity = { port, instanceId: server.instanceId, debug: false };
    fs.writeFileSync(registry, JSON.stringify({ variables: { ['CCP3X_OWNER_' + port]: server.instanceId }, manual_call_templates: [
      { name: 'ccp3x_' + port, url: `http://localhost:${port}/utcp` },
    ] }));
    for (const envelope of [false, true]) {
      setServerProfile('full', [], [], envelope);
      const state = await inspectExtensionStatus(identity, registry);
      assert.equal(state.registry.status, 'matched');
      assert.equal(state.http.status, 'ok');
      assert.equal(state.probe.status, 'responsive');
      assert.equal(state.probe.sceneReady, false);
      const activity = server.requestActivity;
      activity.start('request-1', 'nodeGetTree');
      assert.equal(activity.snapshot().activeCount, 1);
      activity.finish('request-1', 'nodeGetTree', 'completed', 200, Date.now());
      assert.equal(activity.snapshot().recentFinished[0].tool, 'nodeGetTree');
    }
    const wrong = await inspectExtensionStatus({ ...identity, instanceId: 'wrong' }, registry);
    assert.equal(wrong.registry.status, 'mismatch');
    assert.equal(wrong.http.status, 'error');
    assert.equal(wrong.probe, null);
    fs.writeFileSync(registry, '{broken');
    const broken = await inspectExtensionStatus(identity, registry);
    assert.equal(broken.registry.status, 'error');
    assert.equal(broken.http.status, 'ok');
    await server.stop();
    const unreachable = await inspectExtensionStatus(identity, registry);
    assert.equal(unreachable.http.status, 'error');
    assert.equal(unreachable.probe, null);
  } finally {
    await server.stop();
    setServerProfile('full');
    fs.rmSync(dir, { recursive: true, force: true });
    global.Editor = original;
  }
});
