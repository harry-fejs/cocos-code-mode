'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { selectConnection } = require('../../scripts/project-connection');
const { migrate } = require('../../scripts/migrate-project-connections');
const { requireDist } = require('../helpers/require-dist');
const { projectIdentity, storeConnectionState } = requireDist('utcp/project-connection.js');
it('selects exact project and rejects explicit wrong port and unscoped latest selection', () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ccp-select-test-'));
  const priorProject = process.env.CCP_PROJECT_PATH;
  const priorUrl = process.env.CCP_UTCP_URL;
  try {
    delete process.env.CCP_PROJECT_PATH; delete process.env.CCP_UTCP_URL;
    const paths = ['a', 'b'].map((name) => path.join(root, name));
    paths.forEach((value) => fs.mkdirSync(value));
    const projects = {};
    const config = { manual_call_templates: [] };
    paths.forEach((project, index) => {
      const identity = projectIdentity(project); const port = 49301 + index;
      projects[identity.projectId] = { ...identity, port, relayInstanceId: randomUUID(), tokenPath: path.join(root, `${index}.env`), ownerPid: process.pid, active: true, gateway: { origin: null, projectId: null } };
      config.manual_call_templates.push({ name: `ccp3x_${port}`, call_template_type: 'http', url: `http://localhost:${port}/utcp` });
    });
    const configPath = path.join(root, 'utcp.json');
    config.load_variables_from = Object.values(projects).map((entry) => ({ variable_loader_type: 'dotenv', env_file_path: entry.tokenPath }));
    storeConnectionState(configPath, { version: 1, configPath, projects });
    fs.writeFileSync(configPath, JSON.stringify(config));
    assert.equal(selectConnection({ configPath, projectPath: paths[0] }).port, 49301);
    assert.throws(() => selectConnection({ configPath, projectPath: paths[0], url: 'http://localhost:49302' }), /unambiguous/);
    assert.throws(() => selectConnection({ configPath }), /no latest/);
  } finally {
    if (priorProject === undefined) delete process.env.CCP_PROJECT_PATH; else process.env.CCP_PROJECT_PATH = priorProject;
    if (priorUrl === undefined) delete process.env.CCP_UTCP_URL; else process.env.CCP_UTCP_URL = priorUrl;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('dry-run does not mutate and apply quarantines offline CCP while preserving occupied and other products', async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ccp-migrate-test-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const live = server.address().port;
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const offline = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  try {
    const configPath = path.join(root, 'utcp.json');
    const config = { manual_call_templates: [
      { name: `ccp3x_${offline}`, call_template_type: 'http', url: `http://localhost:${offline}/utcp`, auth: { api_key: 'never-copy-this-secret' } },
      { name: `ccp3x_${live}`, call_template_type: 'http', url: `http://localhost:${live}/utcp` },
      { name: 'ccp2x_54508', call_template_type: 'http', url: 'http://localhost:54508/utcp' },
      { name: 'other_product_65273', call_template_type: 'http', url: 'http://localhost:65273/utcp' },
    ], load_variables_from: [{ variable_loader_type: 'dotenv', env_file_path: path.join(root, 'foreign.env') }] };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const original = fs.readFileSync(configPath, 'utf8');
    const dry = await migrate(configPath, false);
    assert.equal(dry.changed, true); assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    const applied = await migrate(configPath, true);
    assert.equal(fs.readFileSync(applied.backup, 'utf8'), original);
    const next = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(next.manual_call_templates.map((value) => value.name), [`ccp3x_${live}`, 'ccp2x_54508', 'other_product_65273']);
    assert.deepEqual(next.load_variables_from, config.load_variables_from);
    assert.equal(next.variables?.CCP_PROJECT_CONNECTIONS, undefined);
    assert.equal(fs.readFileSync(applied.reportPath, 'utf8').includes('never-copy-this-secret'), false);
    assert.equal(applied.projectAssignmentsInferred, 0);
    assert.equal(applied.credentialFilesDeleted, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
