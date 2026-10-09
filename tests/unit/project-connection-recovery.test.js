'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { requireDist } = require('../helpers/require-dist');
const { createProjectLocalAuth } = requireDist('utcp/local-auth.js');
const { getConfigManager } = requireDist('utcp/config-manager.js');
const { connectionRegistryPath, readConnectionState } = requireDist('utcp/project-connection.js');
const gateway = { origin: 'https://assigned.invalid', projectId: 'recovery' };
function failConfigRename(configPath, operation) {
  const prior = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === configPath) throw Object.assign(new Error('injected config sharing violation'), { code: 'EPERM' });
    return prior(source, destination);
  };
  return Promise.resolve().then(operation).finally(() => { fs.renameSync = prior; });
}
it('rolls back registration, credential rotation, and shutdown publication failures and permits normal retry', async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ccp-recovery-test-'));
  const manager = getConfigManager();
  const priorPath = manager.getConfigPath(); const priorEditor = global.Editor;
  global.Editor = { Profile: { async setConfig() {}, async getConfig() {} } };
  try {
    const project = path.join(root, 'project'); fs.mkdirSync(project);
    const configPath = path.join(root, 'utcp.json');
    await manager.setConfigPath(configPath);
    const auth = createProjectLocalAuth(project, randomUUID(), path.join(root, '.ccp', 'local-auth'));
    await assert.rejects(failConfigRename(configPath, () => manager.ensureCocosEditorTemplate(49501, auth, gateway)), /sharing violation/);
    assert.equal(fs.existsSync(connectionRegistryPath(configPath)), false);
    assert.equal(fs.existsSync(auth.tokenPath), false);
    assert.equal(auth.boundPort, undefined);
    await manager.ensureCocosEditorTemplate(49501, auth, gateway);
    const before = [configPath, connectionRegistryPath(configPath), auth.tokenPath].map((file) => fs.readFileSync(file));
    await assert.rejects(failConfigRename(configPath, () => manager.ensureCocosEditorTemplate(49502, auth, gateway)), /sharing violation/);
    [configPath, connectionRegistryPath(configPath), auth.tokenPath].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    assert.equal(auth.boundPort, 49501);
    await manager.ensureCocosEditorTemplate(49502, auth, gateway);
    const configBeforeStop = fs.readFileSync(configPath);
    const registryBeforeStop = fs.readFileSync(connectionRegistryPath(configPath));
    await assert.rejects(failConfigRename(configPath, () => manager.removeCocosEditorTemplate(auth)), /sharing violation/);
    assert.deepEqual(fs.readFileSync(configPath), configBeforeStop);
    assert.deepEqual(fs.readFileSync(connectionRegistryPath(configPath)), registryBeforeStop);
    assert.equal(await manager.getProjectPort(project), 49502);
    assert.equal(await manager.removeCocosEditorTemplate(auth), true);
    const next = createProjectLocalAuth(project, randomUUID(), path.join(root, '.ccp', 'local-auth'));
    await assert.rejects(failConfigRename(configPath, () => manager.ensureCocosEditorTemplate(49502, next, gateway)), /sharing violation/);
    assert.equal(readConnectionState(configPath).projects[auth.projectId].active, false);
    await manager.ensureCocosEditorTemplate(49502, next, gateway);
    assert.equal(readConnectionState(configPath).projects[auth.projectId].relayInstanceId, next.relayInstanceId);
  } finally {
    await manager.setConfigPath(priorPath); global.Editor = priorEditor;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
