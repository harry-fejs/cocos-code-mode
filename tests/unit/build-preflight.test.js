const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { inspectBuildPreflight, inspectBuildEnvironment } = requireDist('utcp/build-preflight.js');
const { manageBuildTaskConfig } = requireDist('utcp/build-task-config.js');
const options = { platform: 'web-mobile', scenes: [{ uuid: 'scene-1', url: 'db://assets/test.scene' }], startScene: 'scene-1' };
let stored;
let writes;
function setup() {
  stored = { id: '0', state: 'success', options: structuredClone(options), rawOptions: undefined, dirty: false };
  writes = 0;
  global.Editor = { Message: { request: async (pkg, name, arg) => {
    if (name === 'query-platform-config') return { config: { 'web-mobile': {} } };
    if (name === 'query-bundle-config') return { 'web-mobile': { supportedCompressionTypes: ['none'] } };
    if (pkg === 'asset-db') return { uuid: 'scene-1', url: 'db://assets/test.scene', importer: 'scene' };
    if (name === 'query-task') return structuredClone(stored);
    if (name === 'update-task') { writes++; Object.assign(stored, structuredClone(arg)); return; }
    if (name === 'query-program-info') return arg === 'java' ? null : { path: '' };
    throw new Error('Unexpected route');
  } } };
}
afterEach(() => { delete global.Editor; });
it('rejects mismatched scene identities and remote builds without server before dispatch', async () => {
  setup();
  const invalid = await inspectBuildPreflight({ ...options, scenes: [{ uuid: 'scene-2', url: 'db://assets/test.scene' }], startScene: 'scene-2', mainBundleIsRemote: true });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.issues.map(x => x.code), ['SCENE_IDENTITY_MISMATCH', 'REMOTE_SERVER_REQUIRED']);
  assert.equal(writes, 0);
});
it('guarded native configuration refuses stale hashes and active tasks, then updates exact terminal task', async () => {
  setup();
  const snapshot = await manageBuildTaskConfig({ operation: 'get', taskId: 0 });
  const next = { ...options, debug: true };
  await assert.rejects(manageBuildTaskConfig({ operation: 'set', taskId: 0, options: next, expectedOptionsSha256: '0'.repeat(64) }), e => e.code === 'BUILD_TASK_CONFIG_CONFLICT');
  stored.state = 'processing';
  await assert.rejects(manageBuildTaskConfig({ operation: 'set', taskId: 0, options: next, expectedOptionsSha256: snapshot.optionsSha256 }), e => e.code === 'BUILD_TASK_CONFIG_BUSY');
  assert.equal(writes, 0);
  stored.state = 'success';
  const result = await manageBuildTaskConfig({ operation: 'set', taskId: 0, options: next, expectedOptionsSha256: snapshot.optionsSha256 });
  assert.deepEqual(stored.options, next);
  assert.equal(result.persisted, false);
});
it('restores options and raw state after an unconfirmed update', async () => {
  setup();
  const before = structuredClone(stored);
  const snapshot = await manageBuildTaskConfig({ operation: 'get', taskId: 0 });
  const request = Editor.Message.request;
  Editor.Message.request = async (...args) => { if (args[1] === 'update-task' && writes === 0) { writes++; stored.options = { broken: true }; throw new Error('IPC failed after mutation'); } return request(...args); };
  await assert.rejects(manageBuildTaskConfig({ operation: 'set', taskId: 0, options: { ...options, debug: true }, expectedOptionsSha256: snapshot.optionsSha256 }), e => e.code === 'BUILD_TASK_CONFIG_WRITE_FAILED');
  assert.deepEqual(stored, before);
});
it('refuses credential-bearing options and reports unconfigured toolchains without exposing paths', async () => {
  setup();
  await assert.rejects(inspectBuildPreflight({ ...options, packages: { android: { keystorePassword: 'not-a-secret-fixture' } } }), e => e.code === 'INVALID_ARGUMENT');
  const result = await inspectBuildEnvironment();
  assert.equal(result.programs.androidSDK.configured, false);
  assert.equal(result.javaInspection, 'unavailable-editor-api');
  assert.equal(result.toolchainVerified, false);
  assert.equal(JSON.stringify(result).includes('commandArgument'), false);
});
