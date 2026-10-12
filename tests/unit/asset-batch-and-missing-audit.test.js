'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');
const { AssetTools } = requireDist('utcp/tools/asset-tools.js');
const { assetQueryMemo } = requireDist('utcp/utils/memo-cache.js');
const { ToolRegistry } = requireDist('utcp/decorators.js');

function withEditor(request) {
  const previous = global.Editor;
  global.Editor = { Message: { request } };
  assetQueryMemo.invalidate();
  return () => {
    assetQueryMemo.invalidate();
    if (previous === undefined) delete global.Editor;
    else global.Editor = previous;
  };
}

describe('asset batch and missing-reference tools', () => {
  it('returns every batch-import outcome and continues after failures', async () => {
    const tools = new AssetTools();
    tools.assetImport = async (item) => {
      if (item.targetAssetPath.includes('bad')) throw new Error('source unavailable');
      return { reference: { id: `id-${item.targetAssetPath}`, type: 'cc.Asset' } };
    };
    const result = await tools.assetBatchImport({ items: [
      { sourceFilesystemPath: 'a.png', targetAssetPath: 'db://assets/a.png' },
      { sourceFilesystemPath: 'missing.png', targetAssetPath: 'db://assets/bad.png' },
      { sourceFilesystemPath: 'c.png', targetAssetPath: 'db://assets/c.png' },
    ] });
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.partial, true);
    assert.deepEqual(result.outcomes.map((item) => item.ok), [true, false, true]);
  });

  it('creates Creator preset assets from exact versioned internal templates with native extensions', async () => {
    const calls = [];
    const restore = withEditor(async (service, message, ...args) => {
      calls.push({ service, message, args });
      if (message === 'copy-asset') return { uuid: 'scene-uuid', type: 'cc.SceneAsset' };
      if (message === 'query-asset-info') return { uuid: 'scene-uuid', type: 'cc.SceneAsset', url: 'db://assets/qualification.scene', isDirectory: false };
      throw new Error(`unexpected request ${service} ${message}`);
    });
    try {
      const result = await new AssetTools().assetCreate({ assetPath: 'db://assets/qualification', preset: 'scene' });
      assert.deepEqual(result, { reference: { id: 'scene-uuid', type: 'cc.SceneAsset' } });
      assert.equal(calls[0].args[0], 'db://internal/default_file_content/scene/default.scene');
    } finally {
      restore();
    }
  });

  it('returns every batch-operation outcome and validates bounds', async () => {
    const tools = new AssetTools();
    tools.assetOperate = async (item) => {
      if (item.operation === 'delete') throw new Error('protected');
      return { reference: item.reference };
    };
    const result = await tools.assetBatchOperate({ items: [
      { operation: 'refresh', reference: { id: 'a' } },
      { operation: 'delete', reference: { id: 'b' } },
    ] });
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.partial, true);
    await assert.rejects(() => tools.assetBatchOperate({ items: [] }), (error) => error.code === 'INVALID_ARGUMENT' && error.status === 400);
  });

  it('audits scene UUIDs against the project asset graph with line evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-missing-'));
    const scene = path.join(root, 'broken.scene');
    fs.writeFileSync(scene, '{"ok":"11111111-1111-1111-1111-111111111111",\n"missing":"22222222-2222-2222-2222-222222222222"}');
    const rows = [
      { uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', url: 'db://assets/broken.scene', type: 'cc.SceneAsset', file: scene, isDirectory: false },
      { uuid: '11111111-1111-1111-1111-111111111111', url: 'db://assets/ok.png', type: 'cc.ImageAsset', isDirectory: false },
    ];
    const restore = withEditor(async (service, message, value) => {
      assert.equal(service, 'asset-db');
      if (message === 'query-assets') return rows;
      throw new Error(`unexpected request ${message} ${value}`);
    });
    try {
      const result = await new AssetTools().assetMissingReferenceAudit({ maxScenes: 10, maxReferences: 10 });
      assert.equal(result.complete, true);
      assert.equal(result.scannedScenes, 1);
      assert.deepEqual(result.missingReferences, [{
        source: { uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', url: 'db://assets/broken.scene' },
        referenceId: '22222222-2222-2222-2222-222222222222',
        line: 2,
      }]);
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers bounded batch and audit routes', () => {
    for (const name of ['assetBatchImport', 'assetBatchOperate', 'assetMissingReferenceAudit']) {
      assert.ok(ToolRegistry.getTools().some(({ tool }) => tool.name === name));
    }
  });
});
