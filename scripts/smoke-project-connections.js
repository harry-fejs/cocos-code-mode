#!/usr/bin/env node
'use strict';
// Isolated real SDK + real authenticated HTTP proof. Never touches user config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const consumerRequire = process.env.CCB_UTCP_CONSUMER_ROOT ? createRequire(path.resolve(process.env.CCB_UTCP_CONSUMER_ROOT, 'package.json')) : require;
const { UtcpClient } = consumerRequire('@utcp/sdk');
consumerRequire('@utcp/http');
consumerRequire('@utcp/dotenv-loader');
const { getConfigManager } = require('../dist/utcp/config-manager');
const { createProjectLocalAuth } = require('../dist/utcp/local-auth');
const { LocalHttpServer, sendJson } = require('../dist/utcp/http-server');
const { readConnectionState } = require('../dist/utcp/project-connection');
async function main() {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ccb-project-smoke-'));
  const priorEditor = global.Editor;
  const manager = getConfigManager();
  const priorConfigPath = manager.getConfigPath();
  const servers = [];
  const clients = [];
  global.Editor = { Profile: { async setConfig() {}, async getConfig() {} } };
  const gateway = { origin: 'https://gateway.invalid', projectId: 'sdk-smoke' };
  try {
    await manager.setConfigPath(path.join(root, 'utcp.json'));
    async function startProject(project, port = 0) {
      fs.mkdirSync(project, { recursive: true });
      const auth = createProjectLocalAuth(project, randomUUID(), path.join(root, 'auth'));
      const server = new LocalHttpServer(auth);
      servers.push(server);
      const actualPort = await server.listen(port);
      await manager.ensureCocosEditorTemplate(actualPort, auth, gateway);
      server.route('GET', '/tools/who', ({ response }) => sendJson(response, 200, { projectId: auth.projectId, session: auth.relayInstanceId }));
      server.route('GET', '/utcp', ({ response }) => sendJson(response, 200, { utcp_version: '1.0.1', manual_version: '1.0.0', tools: [{
        name: 'who', description: 'Read current project identity', inputs: { type: 'object' }, outputs: { type: 'object' }, tags: [],
        tool_call_template: { name: 'who', call_template_type: 'http', http_method: 'GET', url: `http://localhost:${actualPort}/tools/who`,
          headers: { 'x-ccb-relay-instance': '${CCB_RELAY_INSTANCE_ID}', 'x-ccb-bound-port': '${CCB_BOUND_PORT}', 'x-ccb-project-id': '${CCB_LOCAL_PROJECT_ID}' },
          auth: { auth_type: 'api_key', var_name: 'x-ccb-local-token', api_key: '${CCB_LOCAL_TOKEN}', location: 'header' } },
      }] }));
      return { auth, server, port: actualPort };
    }
    async function sdk() {
      const client = await UtcpClient.create(root, JSON.parse(fs.readFileSync(manager.getConfigPath(), 'utf8')));
      clients.push(client);
      return client;
    }
    const a = await startProject(path.join(root, 'a'));
    const b = await startProject(path.join(root, 'b'));
    let client = await sdk();
    assert.deepEqual(await client.callTool(`ccb3x_${a.port}.who`, {}), { projectId: a.auth.projectId, session: a.auth.relayInstanceId });
    assert.deepEqual(await client.callTool(`ccb3x_${b.port}.who`, {}), { projectId: b.auth.projectId, session: b.auth.relayInstanceId });
    assert.equal(manager.readConfig().load_variables_from.length, 2);
    const text = fs.readFileSync(a.auth.tokenPath, 'utf8');
    assert.equal(/^CCB_LOCAL_TOKEN=/m.test(text), false);
    const duplicate = createProjectLocalAuth(a.auth.projectPath, randomUUID(), path.join(root, 'auth'));
    await assert.rejects(manager.ensureCocosEditorTemplate(a.port, duplicate, gateway), /active relay/);
    assert.equal(fs.readFileSync(a.auth.tokenPath, 'utf8'), text);
    await assert.rejects(manager.ensureCocosEditorTemplate(b.port, a.auth, gateway), /different Cocos project/);
    const foreign = await fetch(`http://localhost:${b.port}/tools/who`, { headers: {
      'x-ccb-local-token': a.auth.token, 'x-ccb-relay-instance': b.auth.relayInstanceId,
      'x-ccb-bound-port': String(b.port), 'x-ccb-project-id': a.auth.projectId,
    } });
    assert.equal(foreign.status, 401);
    await a.server.close();
    await manager.removeCocosEditorTemplate(a.auth);
    const restarted = await startProject(a.auth.projectPath, a.port);
    assert.equal(restarted.auth.tokenPath, a.auth.tokenPath);
    assert.notEqual(restarted.auth.token, a.auth.token);
    assert.equal(await manager.removeCocosEditorTemplate(a.auth), false);
    client = await sdk();
    assert.deepEqual(await client.callTool(`ccb3x_${restarted.port}.who`, {}), { projectId: a.auth.projectId, session: restarted.auth.relayInstanceId });
    assert.deepEqual(await client.callTool(`ccb3x_${b.port}.who`, {}), { projectId: b.auth.projectId, session: b.auth.relayInstanceId });
    assert.equal(manager.readConfig().load_variables_from.length, 2);
    assert.equal(manager.readConfig().variables?.CCB_PROJECT_CONNECTIONS, undefined);
    assert.equal(readConnectionState(manager.getConfigPath()).configPath, manager.getConfigPath());
    assert.equal(readConnectionState(manager.getConfigPath()).projects[a.auth.projectId].relayInstanceId, restarted.auth.relayInstanceId);
    // A wrong project header must be denied even with the correct current token/session/port.
    const wrongProject = await fetch(`http://localhost:${b.port}/tools/who`, { headers: {
      'x-ccb-local-token': b.auth.token, 'x-ccb-relay-instance': b.auth.relayInstanceId,
      'x-ccb-bound-port': String(b.port), 'x-ccb-project-id': a.auth.projectId,
    } });
    assert.equal(wrongProject.status, 401);
    console.log(JSON.stringify({ realSdk: true, authenticatedProjects: 2, restartLoaderCount: 2, staleCleanupPreservedNewSession: true, collisionAndCrossProjectRejected: true }));
  } finally {
    for (const client of clients) await client.close();
    for (const server of servers) await server.close();
    await manager.setConfigPath(priorConfigPath);
    global.Editor = priorEditor;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
