'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { requireDist } = require('../helpers/require-dist');
const { createProjectLocalAuth } = requireDist('utcp/local-auth.js');
const { getConfigManager } = requireDist('utcp/config-manager.js');
const { readConnectionState } = requireDist('utcp/project-connection.js');
const { mutateUtcpConfig } = requireDist('utcp/config-store.js');
const gateway = { origin: 'https://assigned.invalid', projectId: 'configured-project' };
async function fixture(run) {
  const root = fs.mkdtempSync(join(homedir(), '.ccb-auth-test-'));
  const priorEditor = global.Editor;
  const manager = getConfigManager();
  const priorPath = manager.getConfigPath();
  global.Editor = { Profile: { async setConfig() {}, async getConfig() {} } };
  try {
    await manager.setConfigPath(join(root, 'utcp.json'));
    const auth = (name) => { const project = join(root, name); fs.mkdirSync(project, { recursive: true }); return createProjectLocalAuth(project, randomUUID(), join(root, 'auth')); };
    await run({ root, manager, auth });
  } finally {
    await manager.setConfigPath(priorPath);
    global.Editor = priorEditor;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
describe('project-scoped local credentials', () => {
  it('refuses live project/port collisions without rotating credentials and preserves a replacement against stale cleanup', async () => fixture(async ({ manager, auth }) => {
    const a = auth('a'); const b = auth('b');
    await manager.ensureCocosEditorTemplate(49101, a, gateway);
    await manager.ensureCocosEditorTemplate(49102, b, gateway);
    const before = fs.readFileSync(a.tokenPath, 'utf8');
    const duplicate = auth('a');
    await assert.rejects(manager.ensureCocosEditorTemplate(49101, duplicate, gateway), /active relay/);
    assert.equal(fs.readFileSync(a.tokenPath, 'utf8'), before);
    await assert.rejects(manager.ensureCocosEditorTemplate(49102, a, gateway), /different Cocos project/);
    await manager.removeCocosEditorTemplate(a);
    const next = auth('a');
    await manager.ensureCocosEditorTemplate(49101, next, gateway);
    assert.equal(await manager.removeCocosEditorTemplate(a), false);
    assert.equal(manager.readConfig().load_variables_from.length, 2);
    assert.equal(readConnectionState(manager.getConfigPath()).projects[a.projectId].relayInstanceId, next.relayInstanceId);
    assert.notEqual(next.token, a.token);
    assert.equal(next.tokenPath, a.tokenPath);
    assert.equal(readConnectionState(manager.getConfigPath()).projects[b.projectId].relayInstanceId, b.relayInstanceId);
  }));
  it('refuses malformed config and optimistic panel writes rather than erasing another project', async () => fixture(async ({ manager, auth }) => {
    const a = auth('a');
    await manager.ensureCocosEditorTemplate(49101, a, gateway);
    const snapshot = manager.readConfig();
    mutateUtcpConfig(manager.getConfigPath(), (config) => { config.variables = { ...config.variables, OTHER_PRODUCT: 'preserved' }; });
    snapshot.manual_call_templates.push({ name: 'panel', call_template_type: 'http' });
    assert.throws(() => manager.writeConfig(snapshot), /changed/);
    assert.equal(manager.readConfig().variables.OTHER_PRODUCT, 'preserved');
    fs.writeFileSync(manager.getConfigPath(), '{malformed');
    await assert.rejects(manager.ensureCocosEditorTemplate(49101, a, gateway));
    assert.equal(fs.readFileSync(manager.getConfigPath(), 'utf8'), '{malformed');
  }));
  it('serializes two real processes registering independent projects into one shared config', async () => fixture(async ({ root, manager }) => {
    const projects = ['a', 'b'].map((name) => join(root, name));
    for (const project of projects) fs.mkdirSync(project);
    const children = projects.map((project, index) => fork(join(__dirname, '..', 'helpers', 'register-project-child.js'), [manager.getConfigPath(), project, join(root, 'auth'), String(49201 + index)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
    await Promise.all(children.map((child) => new Promise((resolve, reject) => {
      let error = ''; child.stderr.on('data', (data) => { error += data; });
      child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error || `child exit ${code}`)));
    })));
    const config = manager.readConfig();
    assert.equal(config.manual_call_templates.length, 2);
    assert.equal(config.load_variables_from.length, 2);
    assert.equal(Object.keys(readConnectionState(manager.getConfigPath()).projects).length, 2);
  }));
});
