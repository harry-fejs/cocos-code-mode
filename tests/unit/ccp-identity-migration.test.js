'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { migrateIdentity } = require('../../scripts/migrate-ccp-identity');
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-cutover-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  let canonical = fs.realpathSync(project).replace(/\\/g, '/');
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const projectId = createHash('sha256').update(canonical).digest('hex');
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const stateRoot = path.join(root, '.cc-bridge');
  fs.mkdirSync(path.join(stateRoot, 'local-auth'), { recursive: true, mode: 0o700 });
  const configPath = path.join(root, 'utcp.json');
  const tokenPath = path.join(stateRoot, 'local-auth', projectId + '.env');
  const relayInstanceId = randomUUID();
  const connection = { projectPath: canonical, projectId, port, relayInstanceId, tokenPath, ownerPid: 2147483647, active: true, gateway: { origin: null, projectId: null } };
  const config = { manual_call_templates: [{ name: `ccb3x_${port}`, call_template_type: 'http', url: `http://localhost:${port}/utcp` }], load_variables_from: [{ variable_loader_type: 'dotenv', env_file_path: tokenPath }], variables: { NEUTRAL_PRODUCT: 'unchanged' } };
  const registry = { version: 1, configPath, projects: { [projectId]: connection } };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(path.join(stateRoot, 'project-connections.json'), JSON.stringify(registry), { mode: 0o600 });
  const prefix = `ccb3x__${port}_`;
  const content = [['CCB_RELAY_INSTANCE_ID', relayInstanceId], ['CCB_LOCAL_TOKEN', 'A'.repeat(43)], ['CCB_BOUND_PORT', port], ['CCB_LOCAL_PROJECT_ID', projectId]].map(([name, value]) => `${prefix}${name}=${value}`).join('\n') + '\n';
  fs.writeFileSync(tokenPath, content, { mode: 0o600 });
  const signed = Buffer.from('{"payload":"immutable-old-domain","signature":"do-not-resign"}\n');
  fs.writeFileSync(path.join(stateRoot, 'root.signed.json'), signed, { mode: 0o600 });
  return { root, project, projectId, port, config, registry, configPath, stateRoot, signed, destination: path.join(root, '.ccp') };
}
const clean = value => fs.rmSync(value.root, { recursive: true, force: true });
it('dry-run is read-only; apply preserves signed bytes as archive and never activates dead credentials', async () => {
  const value = await fixture();
  try {
    const original = fs.readFileSync(value.configPath);
    const report = await migrateIdentity({ ...value, apply: false });
    assert.equal(report.projects, 1); assert.equal(fs.existsSync(value.destination), false);
    assert.deepEqual(fs.readFileSync(value.configPath), original);
    const applied = await migrateIdentity({ ...value, apply: true });
    assert.deepEqual(fs.readFileSync(path.join(applied.backup, 'utcp-config.json')), original);
    assert.deepEqual(fs.readFileSync(path.join(applied.backup, 'state', 'root.signed.json')), value.signed);
    assert.deepEqual(fs.readFileSync(path.join(value.destination, 'legacy-signed-state', 'root.signed.json')), value.signed);
    assert.equal(fs.existsSync(path.join(value.destination, 'root.signed.json')), false);
    const next = JSON.parse(fs.readFileSync(value.configPath));
    assert.deepEqual(next.manual_call_templates, []); assert.deepEqual(next.load_variables_from, []);
    assert.deepEqual(next.variables, { NEUTRAL_PRODUCT: 'unchanged' });
    const registry = JSON.parse(fs.readFileSync(path.join(value.destination, 'project-connections.json')));
    assert.equal(registry.projects[value.projectId].active, false);
    assert.equal(registry.projects[value.projectId].port, value.port);
    const credentials = fs.readFileSync(registry.projects[value.projectId].tokenPath, 'utf8');
    assert.match(credentials, new RegExp(`ccp3x__${value.port}_CCP_LOCAL_PROJECT_ID=${value.projectId}`));
    assert.equal(credentials.includes('CCB_'), false);
  } finally { clean(value); }
});
it('refuses occupied ports without publishing or modifying config', async () => {
  const value = await fixture(); const server = net.createServer();
  try {
    await new Promise(resolve => server.listen(value.port, '127.0.0.1', resolve));
    const before = fs.readFileSync(value.configPath);
    await assert.rejects(migrateIdentity({ ...value, apply: true }), /occupied|unverifiable/);
    assert.deepEqual(fs.readFileSync(value.configPath), before); assert.equal(fs.existsSync(value.destination), false);
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); clean(value); }
});
it('refuses a foreign root or destination conflict before any write', async () => {
  const value = await fixture();
  try {
    const before = fs.readFileSync(value.configPath);
    await assert.rejects(migrateIdentity({ ...value, stateRoot: path.join(value.root, 'foreign'), apply: true }), /state root/);
    fs.mkdirSync(value.destination);
    await assert.rejects(migrateIdentity({ ...value, apply: true }), /destination already exists/);
    assert.deepEqual(fs.readFileSync(value.configPath), before);
  } finally { clean(value); }
});
it('accepts a proven embedded-only registry but refuses contradictory embedded/external records', async () => {
  const value = await fixture();
  try {
    value.config.variables.CCB_PROJECT_CONNECTIONS = JSON.stringify({ version: 1, projects: value.registry.projects });
    fs.writeFileSync(value.configPath, JSON.stringify(value.config));
    fs.unlinkSync(path.join(value.stateRoot, 'project-connections.json'));
    const dry = await migrateIdentity({ ...value }); assert.equal(dry.projects, 1);
    const conflict = structuredClone(value.registry); conflict.projects[value.projectId].relayInstanceId = randomUUID();
    fs.writeFileSync(path.join(value.stateRoot, 'project-connections.json'), JSON.stringify(conflict), { mode: 0o600 });
    await assert.rejects(migrateIdentity({ ...value, apply: true }), /registries conflict/);
    assert.equal(fs.existsSync(value.destination), false);
  } finally { clean(value); }
});
