'use strict';
const { randomUUID } = require('node:crypto');
const { requireDist } = require('./require-dist');
const { createProjectLocalAuth } = requireDist('utcp/local-auth.js');
const { getConfigManager } = requireDist('utcp/config-manager.js');
global.Editor = { Profile: { async setConfig() {}, async getConfig() {} } };
(async () => {
  const [config, project, root, port] = process.argv.slice(2);
  const manager = getConfigManager();
  await manager.setConfigPath(config);
  await manager.ensureCocosEditorTemplate(Number(port), createProjectLocalAuth(project, randomUUID(), root), { origin: 'https://assigned.invalid', projectId: 'parallel' });
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
