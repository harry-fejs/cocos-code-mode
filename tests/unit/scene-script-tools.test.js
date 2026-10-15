'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source() {
  return fs.readFileSync(path.resolve(__dirname, '../../source/utcp/tools/scene-tools.ts'), 'utf8');
}

const { requireDist } = require('../helpers/require-dist');
const { SceneTools } = requireDist('utcp/tools/scene-tools.js');
describe('scene script health tools', () => {
  it('refuses malformed component entries instead of reporting a healthy scene', async () => {
    const previous = global.Editor;
    let components = [];
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node-tree') return { uuid: 'root', components };
      if (message === 'query-components') return [];
      if (message === 'query-current-scene') return 'root';
      throw new Error(`unexpected ${message}`);
    } } };
    try {
      for (components of [[null], [7], [[]], new Array(1)]) {
        await assert.rejects(new SceneTools().sceneScriptHealthScan(), error => error.code === 'INVALID_RESPONSE');
        const batch = await new SceneTools().sceneScriptHealthBatchScan({ nodeReferences: [{ id: 'root' }] });
        assert.equal(batch.failed, 1);
        assert.equal(batch.items[0].error.code, 'INVALID_RESPONSE');
      }
      components = [];
      const healthy = await new SceneTools().sceneScriptHealthScan();
      assert.equal(healthy.total, 0);
      assert.equal(healthy.truncated, false);
    } finally { if (previous === undefined) delete global.Editor; else global.Editor = previous; }
  });

  it('does not remove components or claim restoration after lost attachment response', async () => {
    const previous = global.Editor;
    const mutations = [];
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node') return { __comps__: [] };
      if (message === 'query-script-cid') return 'Hero';
      if (message === 'query-components') return [{ cid: 'Hero' }];
      mutations.push(message);
      if (message === 'create-component') throw new Error('response lost after dispatch');
      throw new Error(`unexpected ${message}`);
    } } };
    try {
      await assert.rejects(new SceneTools().sceneScriptAttach({ nodeReference: { id: 'node' }, scriptReference: { id: 'script' } }), error => error.code === 'SCRIPT_ATTACH_OUTCOME_UNKNOWN' && error.details.retrySafe === false && error.details.restored === null);
      assert.deepEqual(mutations, ['create-component']);
    } finally { if (previous === undefined) delete global.Editor; else global.Editor = previous; }
  });
  it('registers a bounded script attach route with script metadata preflight', () => {
    const src = source();
    assert.match(src, /'sceneScriptAttach'/);
    assert.match(src, /query-script-cid/);
    assert.match(src, /SCRIPT_ALREADY_ATTACHED/);
    assert.match(src, /SCRIPT_ATTACH_UNCONFIRMED/);
    assert.match(src, /componentReference/);
  });
  it('registers a bounded script detach route with read-back errors', () => {
    const src = source();
    assert.match(src, /'sceneScriptDetach'/);
    assert.match(src, /SCRIPT_DETACH_UNCONFIRMED/);
    assert.match(src, /'scene', 'remove-component'/);
    assert.match(src, /removedComponent/);
  });
  it('registers scene script usage inspection', () => {
    const src = source();
    assert.match(src, /'sceneScriptUsageInspect'/);
    assert.match(src, /query-node-tree/);
    assert.match(src, /usages/);
  });
  it('registers custom script component inspection', () => {
    const src = source();
    assert.match(src, /'sceneScriptComponentInspect'/);
    assert.match(src, /query-component/);
    assert.match(src, /TYPE_MISMATCH/);
  });
  it('registers SpriteFrame scene usage inspection', () => {
    const src = source();
    assert.match(src, /'spriteFrameUsageInspect'/);
    assert.match(src, /findNodesByAsset/);
  });
  it('supports bounded class filtering for script usage', () => {
    const src = source();
    assert.match(src, /classId.*maxLength: 256/);
    assert.match(src, /classId !== args\.classId/);
  });
  it('registers scene script component batch inspection', () => {
    const src = source();
    assert.match(src, /'sceneScriptComponentBatchInspect'/);
    assert.match(src, /componentReferences/);
  });
  it('registers scene script attach batch route', () => {
    const src = source();
    assert.match(src, /'sceneScriptBatchAttach'/);
    assert.match(src, /partial/);
  });
  it('registers scene script detach batch route', () => {
    const src = source();
    assert.match(src, /'sceneScriptBatchDetach'/);
    assert.match(src, /detach requests/);
  });
  it('registers script usage summary', () => {
    const src = source();
    assert.match(src, /'sceneScriptUsageSummary'/);
    assert.match(src, /totalClasses/);
  });
  it('registers SpriteFrame usage batch and script asset linkage', () => {
    const src = source();
    assert.match(src, /'spriteFrameUsageBatchInspect'/);
    assert.match(src, /'scriptAssetSceneUsageInspect'/);
  });
  it('registers image scene usage, SpriteFrame usage batch, and script asset linkage', () => {
    const src = source();
    assert.match(src, /'imageSceneUsageInspect'/);
    assert.match(src, /'spriteFrameUsageBatchInspect'/);
    assert.match(src, /'scriptAssetSceneUsageInspect'/);
  });
  it('registers script health batch scanning', () => {
    const src = source();
    assert.match(src, /'sceneScriptHealthBatchScan'/);
    assert.match(src, /limitPerRoot/);
  });
  it('registers script repair batch route', () => {
    const src = source();
    assert.match(src, /'sceneScriptRepairBatch'/);
    assert.match(src, /repair requests/);
  });
  it('registers script asset scene usage batch inspection', () => {
    const src = source();
    assert.match(src, /'scriptAssetSceneUsageBatchInspect'/);
    assert.match(src, /limitPerScript/);
  });
  it('isolates script asset usage failures and preserves bounded limits', async () => {
    const tools = new SceneTools();
    const calls = [];
    tools.scriptAssetSceneUsageInspect = async ({ scriptReference, limit }) => {
      calls.push({ id: scriptReference.id, limit });
      if (scriptReference.id === 'broken') throw new Error('script metadata unavailable');
      return { scriptReference, classId: 'Hero', usages: [], total: 1, truncated: scriptReference.id === 'truncated' };
    };
    const result = await tools.scriptAssetSceneUsageBatchInspect({ scriptReferences: [{ id: 'ok' }, { id: 'broken' }, { id: 'truncated' }], limitPerScript: 5 });
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.partial, true);
    assert.equal(result.truncated, true);
    assert.deepEqual(calls, [{ id: 'ok', limit: 5 }, { id: 'broken', limit: 5 }, { id: 'truncated', limit: 5 }]);
    assert.equal(result.items[1].error.message, 'script metadata unavailable');
  });
});
