'use strict';
const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');
const { AdvancedCapabilityTools } = requireDist('utcp/tools/advanced-capability-tools.js');
const { PrefabJsonTools } = requireDist('utcp/tools/prefab-json-tools.js');
let dir;
afterEach(() => { delete global.Editor; if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });
function fixture() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefab-boundaries-'));
  const file = path.join(dir, 'source.prefab');
  fs.writeFileSync(file, '{"name":"Before"}');
  const row = { uuid: 'prefab', url: 'db://assets/source.prefab', type: 'cc.Prefab', file };
  let mutations = 0;
  global.Editor = { Message: { request: async (service, message) => {
    if (service === 'asset-db' && message === 'query-asset-info') return row;
    if (service === 'scene' && message === 'query-node') return { uuid: 'instance', __prefab__: { uuid: 'prefab', instance: { propertyOverrides: [{ path: 'name', value: 'After' }, { path: 'active', value: false }] } } };
    if (service === 'scene' && message === 'execute-scene-script') { mutations++; fs.writeFileSync(file, '{"name":"After"}'); return null; }
    if (message === 'snapshot') return true;
    throw new Error(`Unexpected ${service}:${message}`);
  } } };
  return { file, mutations: () => mutations };
}
it('refuses stale source hash before mutation and reports actual apply source diff', async () => {
  const f = fixture();
  const tools = new AdvancedCapabilityTools();
  const inspected = await tools.prefabInstanceInspect({ reference: { id: 'instance' }, maxOverrides: 1 });
  assert.equal(inspected.totalOverrides, 2);
  assert.equal(inspected.truncated, true);
  await assert.rejects(tools.prefabApplyOverrides({ reference: { id: 'instance' }, expectedSourceSha256: '0'.repeat(64) }), e => e.code === 'PREFAB_SOURCE_CONFLICT');
  assert.equal(f.mutations(), 0);
  const applied = await tools.prefabApplyOverrides({ reference: { id: 'instance' }, expectedSourceSha256: inspected.source.sha256 });
  assert.deepEqual(applied.sourceChanges.map(c => [c.path, c.before, c.after]), [['name', 'Before', 'After']]);
  assert.equal(applied.sceneSaved, false);
  await assert.rejects(tools.prefabApplyOverrides({ reference: { id: 'instance' }, expectedSourceSha256: inspected.source.sha256 }), e => e.code === 'PREFAB_SOURCE_CONFLICT');
  assert.equal(f.mutations(), 1);
});
it('does not declare a truncated reference check valid when the omitted reference is missing', async () => {
  const f = fixture();
  const first = '11111111-1111-1111-1111-111111111111';
  const second = '22222222-2222-2222-2222-222222222222';
  fs.writeFileSync(f.file, JSON.stringify([{ __type__: 'cc.Node', _name: 'Root', a: { __uuid__: first }, b: { __uuid__: second } }]));
  const original = global.Editor.Message.request;
  global.Editor.Message.request = async (service, message, ...args) => message === 'query-assets' ? [{ uuid: first }] : original(service, message, ...args);
  const tools = new PrefabJsonTools();
  const limited = await tools.prefabValidate({ reference: { id: 'prefab' }, maxReferences: 1 });
  assert.equal(limited.valid, false);
  assert.equal(limited.complete, false);
  assert.equal(limited.totalReferences, 2);
  const full = await tools.prefabValidate({ reference: { id: 'prefab' } });
  assert.equal(full.complete, true);
  assert.deepEqual(full.missingReferences, [{ id: second }]);
});
