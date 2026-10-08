'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');
const { UtcpServerManager } = requireDist('utcp/utcp-server.js');
const { getConfigManager } = requireDist('utcp/config-manager.js');
const { selectConnection, connectionHeaders } = require('../../scripts/project-connection');
it('starts same project under two custom configs without overwriting either live credential', async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ccb-config-auth-test-'));
  const priorEditor = global.Editor; const manager = getConfigManager(); const priorConfig = manager.getConfigPath();
  const servers = [];
  try {
    const project = path.join(root, 'project'); fs.mkdirSync(project);
    global.Editor = { Project: { path: project }, Profile: { async setConfig() {}, async getConfig() {} } };
    const configurations = ['a', 'b'].map((name) => { const directory = path.join(root, name); fs.mkdirSync(directory); return path.join(directory, 'utcp.json'); });
    const bindings = [];
    for (const configPath of configurations) {
      await manager.setConfigPath(configPath);
      const host = { gatewayContext: { origin: null, projectId: null } };
      const server = new UtcpServerManager(host);
      servers.push({ server, configPath });
      await server.start(0);
      const binding = server.getLocalAuthBinding(); bindings.push(binding);
    }
    assert.notEqual(bindings[0].tokenPath, bindings[1].tokenPath);
    assert.equal(path.dirname(bindings[0].tokenPath), path.join(root, 'a', '.cc-bridge', 'local-auth'));
    assert.equal(path.dirname(bindings[1].tokenPath), path.join(root, 'b', '.cc-bridge', 'local-auth'));
    for (let index = 0; index < configurations.length; index++) {
      const connection = selectConnection({ configPath: configurations[index], projectPath: project });
      const response = await fetch(`${connection.base}/tools/nonexistent`, { headers: connectionHeaders(connection) });
      // Authentication passed through real ingress to route lookup (not 401).
      assert.equal(response.status, 404);
    }
  } finally {
    for (const { server, configPath } of servers) { await manager.setConfigPath(configPath); await server.stop(); }
    await manager.setConfigPath(priorConfig); global.Editor = priorEditor;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
