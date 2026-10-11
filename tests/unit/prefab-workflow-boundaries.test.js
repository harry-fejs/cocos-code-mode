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
it('counts mounted and removed overrides and bounds oversized read-back and override values', async () => {
  fixture();
  const original = Editor.Message.request;
  Editor.Message.request = async (service, message, ...args) => {
    // Creator wraps each override array, not only the prefab instance object.
    if (message === 'query-node') return { uuid: 'instance', name: { value: 'Root' }, huge: '雪'.repeat(20000), __prefab__: { uuid: 'prefab', instance: { value: { propertyOverrides: { value: [{ value: '雪'.repeat(10000) }], type: 'cc.PropertyOverrideInfo' }, mountedChildren: { value: [{ nodes: ['child'] }], type: 'cc.MountedChildrenInfo' }, mountedComponents: { value: [{ components: ['component'] }], type: 'cc.MountedComponentsInfo' }, removedComponents: { value: [{ localID: ['removed'] }], type: 'cc.TargetInfo' } }, type: 'cc.PrefabInstance' } } };
    return original(service, message, ...args);
  };
  const tools = new AdvancedCapabilityTools();
  const result = await tools.prefabInstanceInspect({ reference: { id: 'instance' }, maxBytes: 2048 });
  assert.deepEqual(result.overrideCounts, { propertyOverrides: 1, mountedChildren: 1, mountedComponents: 1, removedComponents: 1 });
  assert.equal(result.totalOverrides, 4);
  assert.equal(result.responseTruncated, true);
  assert.equal(result.readBackTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 2048);
  const applied = await tools.prefabApplyOverrides({ reference: { id: 'instance' }, expectedSourceSha256: result.source.sha256, maxBytes: 2048 });
  assert.ok(Buffer.byteLength(JSON.stringify(applied), 'utf8') <= 2048);
  assert.equal(applied.sourceReadBack.id, 'prefab');
  assert.equal(applied.sceneSaved, false);
});
