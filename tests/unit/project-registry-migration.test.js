'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { migrate } = require('../../scripts/migrate-project-connections');
const { selectConnection } = require('../../scripts/project-connection');
const { requireDist } = require('../helpers/require-dist');
const { connectionRegistryPath, projectIdentity, readConnectionState, storeConnectionState } = requireDist('utcp/project-connection.js');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ccb-registry-test-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const configPath = path.join(root, 'utcp.json');
  const identity = projectIdentity(project);
  const connection = { ...identity, port: 49401, relayInstanceId: randomUUID(), tokenPath: path.join(root, 'private.env'), ownerPid: process.pid, active: true, gateway: { origin: 'https://assigned.invalid', projectId: 'assigned' } };
  const config = { manual_call_templates: [{ name: 'ccb3x_49401', call_template_type: 'http', url: 'http://localhost:49401/utcp' }], load_variables_from: [{ variable_loader_type: 'dotenv', env_file_path: connection.tokenPath }], variables: { OTHER_PRODUCT: 'preserve', CCB_PROJECT_CONNECTIONS: JSON.stringify({ version: 1, projects: { [identity.projectId]: connection }, quarantined: [{ kind: 'loader', reference: 'offline.env', reason: 'offline-project-unknown', status: 'unresolved' }] }) } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(connection.tokenPath, 'private-file-untouched');
  return { root, configPath, identity, connection, config };
}
it('externalizes embedded metadata with durable backup/history before removal and is idempotent', async () => {
  const value = fixture();
  try {
    const original = fs.readFileSync(value.configPath, 'utf8');
    await migrate(value.configPath, false);
    assert.equal(fs.existsSync(connectionRegistryPath(value.configPath)), false);
    assert.equal(fs.readFileSync(value.configPath, 'utf8'), original);
    const report = await migrate(value.configPath, true);
    const next = JSON.parse(fs.readFileSync(value.configPath, 'utf8'));
    assert.deepEqual(next.variables, { OTHER_PRODUCT: 'preserve' });
    assert.equal(fs.readFileSync(report.backup, 'utf8'), original);
    assert.equal(readConnectionState(value.configPath).projects[value.identity.projectId].relayInstanceId, value.connection.relayInstanceId);
    assert.deepEqual(JSON.parse(fs.readFileSync(report.reportPath, 'utf8')).quarantined, JSON.parse(value.config.variables.CCB_PROJECT_CONNECTIONS).quarantined);
    assert.equal(fs.readFileSync(value.connection.tokenPath, 'utf8'), 'private-file-untouched');
    const second = await migrate(value.configPath, true);
    assert.equal(second.changed, false); assert.equal(second.backup, null); assert.equal(second.reportPath, null);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
it('refuses conflicting external records without mutating config or registry', async () => {
  const value = fixture();
  try {
    storeConnectionState(value.configPath, { version: 1, configPath: value.configPath, projects: { [value.identity.projectId]: { ...value.connection, relayInstanceId: randomUUID() } } });
    const configBefore = fs.readFileSync(value.configPath, 'utf8');
    const registryBefore = fs.readFileSync(connectionRegistryPath(value.configPath), 'utf8');
    await assert.rejects(migrate(value.configPath, true), /conflict/);
    assert.equal(fs.readFileSync(value.configPath, 'utf8'), configBefore);
    assert.equal(fs.readFileSync(connectionRegistryPath(value.configPath), 'utf8'), registryBefore);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
it('refuses config/registry disagreement and isolates custom config directories', async () => {
  const value = fixture();
  try {
    await migrate(value.configPath, true);
    const config = JSON.parse(fs.readFileSync(value.configPath, 'utf8'));
    config.manual_call_templates[0].url = 'http://localhost:49402/utcp';
    fs.writeFileSync(value.configPath, JSON.stringify(config));
    assert.throws(() => selectConnection({ configPath: value.configPath, projectPath: value.identity.projectPath }), /disagree/);
    const otherDirectory = path.join(value.root, 'other'); fs.mkdirSync(otherDirectory);
    const otherConfigPath = path.join(otherDirectory, 'utcp.json');
    fs.writeFileSync(otherConfigPath, JSON.stringify({ manual_call_templates: [] }));
    assert.deepEqual(readConnectionState(otherConfigPath).projects, {});
    assert.notEqual(connectionRegistryPath(otherConfigPath), connectionRegistryPath(value.configPath));
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
