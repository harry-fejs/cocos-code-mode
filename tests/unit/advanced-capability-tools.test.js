'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');
const { AdvancedCapabilityTools } = requireDist('utcp/tools/advanced-capability-tools.js');
const { PrefabJsonTools } = requireDist('utcp/tools/prefab-json-tools.js');
const { ToolRegistry } = requireDist('utcp/decorators.js');

describe('advanced capability tools', () => {
  it('returns stable prefab override identities from serialized source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-prefab-diff-'));
    const baseline = path.join(root, 'baseline.prefab');
    const current = path.join(root, 'current.prefab');
    fs.writeFileSync(baseline, JSON.stringify({ nodes: [{ name: 'Root', value: 1 }] }));
    fs.writeFileSync(current, JSON.stringify({ nodes: [{ name: 'Root', value: 2 }] }));
    const previous = global.Editor;
    global.Editor = { Message: { request: async (_service, message, identifier) => {
      const file = identifier === 'baseline' ? baseline : current;
      return { uuid: identifier, url: `db://assets/${identifier}.prefab`, type: 'cc.Prefab', file };
    } } };
    try {
      const result = await new AdvancedCapabilityTools().prefabOverrideDiff({ reference: { id: 'current' }, baselineReference: { id: 'baseline' } });
      assert.equal(result.equal, false);
      assert.equal(result.changes[0].identity, 'nodes.0.value:number');
      assert.match(result.source.sha256, /^[a-f0-9]{64}$/);
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('inspects serialized prefab structure with bounded component and UUID summaries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-prefab-inspect-'));
    const file = path.join(root, 'fixture.prefab');
    fs.writeFileSync(file, JSON.stringify({ __type__: 'cc.Node', child: { __type__: 'cc.Sprite', asset: '11111111-1111-1111-1111-111111111111@sub' } }));
    const previous = global.Editor;
    const row = { uuid: 'prefab-asset', url: 'db://assets/fixture.prefab', type: 'cc.Prefab', file };
    global.Editor = { Message: { request: async (service, message) => {
      if (service === 'asset-db' && message === 'query-asset-info') return row;
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const result = await new (requireDist('utcp/tools/prefab-json-tools.js').PrefabJsonTools)().prefabInspect({ reference: { id: 'prefab-asset', type: 'cc.Prefab' } });
      assert.equal(result.uuid, 'prefab-asset');
      assert.equal(result.totalEntries, 2);
      assert.deepEqual(result.components, ['cc.Node', 'cc.Sprite']);
      assert.deepEqual(result.references, ['11111111-1111-1111-1111-111111111111']);
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('inspects and edits imported TMX layers and objects with source read-back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-tmx-'));
    const file = path.join(root, 'fixture.tmx');
    fs.writeFileSync(file, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<map orientation="orthogonal" width="2" height="2" tilewidth="32" tileheight="32">',
      '  <layer id="1" name="Ground" width="2" height="2" opacity="1"><data encoding="csv">1,0,0,1</data></layer>',
      '  <objectgroup id="2" name="Entities"><object id="7" name="Spawn" x="16" y="16"/></objectgroup>',
      '</map>',
    ].join('\n'));
    const previous = global.Editor;
    const row = { uuid: 'fixture-uuid', url: 'db://assets/fixture.tmx', type: 'cc.TiledMapAsset', file };
    global.Editor = { Message: { request: async (service, message, identifier, content) => {
      if (service !== 'asset-db') throw new Error(`unexpected ${service}:${message}`);
      if (message === 'query-asset-info') return row;
      if (message === 'query-assets') return [row];
      if (message === 'save-asset') { fs.writeFileSync(file, content); return row; }
      if (message === 'reimport-asset') return true;
      throw new Error(`unexpected asset-db message ${message} ${identifier}`);
    } } };
    try {
      const tools = new AdvancedCapabilityTools();
      const inventory = await tools.tilemapInspect({ reference: { id: 'fixture-uuid' }, maxLayers: 4 });
      assert.equal(inventory.layers[0].name, 'Ground');
      assert.equal(inventory.layers[0].tileCount, 4);
      assert.equal(inventory.objectGroups[0].objects[0].id, '7');
      const layer = await tools.tilemapLayerEdit({ reference: { id: 'fixture-uuid' }, path: 'layers.Ground.opacity', value: 0.5 });
      assert.equal(layer.persisted, true);
      const object = await tools.tilemapObjectEdit({ reference: { id: 'fixture-uuid' }, path: 'objects.7.x', value: 24 });
      assert.equal(object.persisted, true);
      assert.match(fs.readFileSync(file, 'utf8'), /opacity="0\.5"/);
      assert.match(fs.readFileSync(file, 'utf8'), /id="7" name="Spawn" x="24"/);
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('validates TMX gid ranges and layer dimensions alongside UUID references', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-tmx-validate-'));
    const goodFile = path.join(root, 'good.tmx');
    const badFile = path.join(root, 'bad.tmx');
    fs.writeFileSync(goodFile, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<map orientation="orthogonal" width="2" height="2" tilewidth="32" tileheight="32">',
      '  <tileset firstgid="1" name="Tiles" tilecount="2"/>',
      '  <layer id="1" name="Ground" width="2" height="2"><data encoding="csv">1,2,0,0</data></layer>',
      '</map>',
    ].join('\n'));
    fs.writeFileSync(badFile, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<map orientation="orthogonal" width="2" height="2" tilewidth="32" tileheight="32">',
      '  <tileset firstgid="1" name="Tiles" tilecount="1"/>',
      '  <layer id="1" name="Ground" width="3" height="2"><data encoding="csv">1,5,0,0,0,0</data></layer>',
      '</map>',
    ].join('\n'));
    const previous = global.Editor;
    global.Editor = { Message: { request: async (service, message, identifier) => {
      if (service !== 'asset-db') throw new Error(`unexpected ${service}:${message}`);
      if (message === 'query-asset-info') return { uuid: identifier, url: `db://assets/${identifier}.tmx`, type: 'cc.TiledMapAsset', file: identifier === 'good' ? goodFile : badFile };
      if (message === 'query-assets') return [];
      throw new Error(`unexpected asset-db message ${message}`);
    } } };
    try {
      const tools = new AdvancedCapabilityTools();
      const good = await tools.tilemapValidate({ reference: { id: 'good' } });
      assert.equal(good.valid, true);
      assert.deepEqual(good.gidIssues, []);
      assert.deepEqual(good.dimensionIssues, []);
      assert.equal(good.gidRangeVerified, true);

      const bad = await tools.tilemapValidate({ reference: { id: 'bad' } });
      assert.equal(bad.valid, false);
      assert.deepEqual(bad.gidIssues, [{ gid: 5, layer: 'Ground' }]);
      assert.deepEqual(bad.dimensionIssues, [{ layer: 'Ground', width: 3, height: 2, mapWidth: 2, mapHeight: 2 }]);

      // A flipped tile carries Tiled rotation flags in the gid's high bits; the masked
      // gid must stay inside the tileset range and the map must remain valid.
      const flippedFile = path.join(root, 'flipped.tmx');
      fs.writeFileSync(flippedFile, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<map orientation="orthogonal" width="2" height="2" tilewidth="32" tileheight="32">',
        '  <tileset firstgid="1" name="Tiles" tilecount="2"/>',
        '  <layer id="1" name="Ground" width="2" height="2"><data encoding="csv">1,3221225474,0,0</data></layer>',
        '</map>',
      ].join('\n'));
      global.Editor.Message.request = async (service, message, identifier) => {
        if (message === 'query-asset-info') return { uuid: identifier, url: `db://assets/${identifier}.tmx`, type: 'cc.TiledMapAsset', file: flippedFile };
        if (message === 'query-assets') return [];
        throw new Error(`unexpected asset-db message ${message}`);
      };
      const flipped = await tools.tilemapValidate({ reference: { id: 'flipped' } });
      assert.deepEqual(flipped.gidIssues, []);
      assert.equal(flipped.valid, true);
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('resolves external .tsx tileset ranges and flags unresolvable ones', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-tmx-ext-'));
    const tmx = path.join(root, 'map.tmx');
    const tsx = path.join(root, 'tiles.tsx');
    fs.writeFileSync(tsx, '<?xml version="1.0"?><tileset tilecount="2" tilewidth="32" tileheight="32"><tile id="0"/></tileset>');
    const writeMap = (gids) => fs.writeFileSync(tmx, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<map orientation="orthogonal" width="2" height="2" tilewidth="32" tileheight="32">',
      '  <tileset firstgid="1" source="tiles.tsx"/>',
      `  <layer id="1" name="Ground" width="2" height="2"><data encoding="csv">${gids}</data></layer>`,
      '</map>',
    ].join('\n'));
    writeMap('1,2,0,0');
    const previous = global.Editor;
    global.Editor = { Message: { request: async (service, message, identifier) => {
      if (service !== 'asset-db') throw new Error(`unexpected ${service}:${message}`);
      if (message === 'query-asset-info') return { uuid: identifier, url: 'db://assets/map.tmx', type: 'cc.TiledMapAsset', file: tmx };
      if (message === 'query-assets') return [];
      throw new Error(`unexpected asset-db message ${message}`);
    } } };
    try {
      const tools = new AdvancedCapabilityTools();
      const inRange = await tools.tilemapValidate({ reference: { id: 'map' } });
      assert.deepEqual(inRange.gidIssues, []);
      assert.deepEqual(inRange.unverifiedTilesets, []);
      assert.equal(inRange.gidRangeVerified, true);

      writeMap('1,5,0,0');
      const outOfRange = await tools.tilemapValidate({ reference: { id: 'map' } });
      assert.deepEqual(outOfRange.gidIssues, [{ gid: 5, layer: 'Ground' }]);

      fs.rmSync(tsx, { force: true });
      const unresolvable = await tools.tilemapValidate({ reference: { id: 'map' } });
      assert.deepEqual(unresolvable.unverifiedTilesets, ['tiles.tsx']);
      assert.equal(unresolvable.gidRangeVerified, false);
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects non-scene assets and reports reference truncation for scenes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-scene-ref-'));
    const sceneFile = path.join(root, 'level.scene');
    const prefabFile = path.join(root, 'thing.prefab');
    const uuidA = '11111111-1111-1111-1111-111111111111';
    const uuidB = '22222222-2222-2222-2222-222222222222';
    fs.writeFileSync(sceneFile, JSON.stringify({ refs: [uuidA, uuidB, '33333333-3333-3333-3333-333333333333'] }));
    fs.writeFileSync(prefabFile, '{}');
    const previous = global.Editor;
    global.Editor = { Message: { request: async (service, message, identifier) => {
      if (service !== 'asset-db') throw new Error(`unexpected ${service}:${message}`);
      if (message === 'query-asset-info') {
        if (identifier === 'level') return { uuid: 'level', url: 'db://assets/level.scene', type: 'cc.SceneAsset', file: sceneFile };
        return { uuid: identifier, url: `db://assets/${identifier}.prefab`, type: 'cc.Prefab', file: prefabFile };
      }
      if (message === 'query-assets') return [{ uuid: uuidA, url: 'db://assets/a.png' }, { uuid: uuidB, url: 'db://assets/b.png' }];
      throw new Error(`unexpected asset-db message ${message}`);
    } } };
    try {
      const tools = new AdvancedCapabilityTools();
      const result = await tools.sceneReferenceValidate({ reference: { id: 'level' }, maxReferences: 2 });
      assert.equal(result.totalReferences, 3);
      assert.equal(result.truncated, true);
      assert.equal(result.valid, false);
      assert.deepEqual(result.references, [uuidA, uuidB]);
      assert.deepEqual(result.missingReferences, ['33333333-3333-3333-3333-333333333333']);
      assert.equal(result.totalMissingReferences, 1);
      await assert.rejects(() => tools.sceneReferenceValidate({ reference: { id: 'thing' } }), (error) => error.code === 'TYPE_MISMATCH' && error.status === 422);
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('checks missing scene references beyond the 2000-item response cap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-full-scene-audit-'));
    const sceneFile = path.join(root, 'many.scene');
    const ids = Array.from({ length: 2001 }, (_, index) => `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`);
    fs.writeFileSync(sceneFile, JSON.stringify({ references: ids }));
    const previous = global.Editor;
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-asset-info') return { uuid: 'many', url: 'db://assets/many.scene', type: 'cc.SceneAsset', file: sceneFile };
      if (message === 'query-assets') return ids.slice(0, -1).map((uuid) => ({ uuid, url: `db://assets/${uuid}.png` }));
      throw new Error(`unexpected ${message}`);
    } } };
    try {
      const result = await new AdvancedCapabilityTools().sceneReferenceValidate({ reference: { id: 'many' } });
      assert.equal(result.valid, false);
      assert.equal(result.totalReferences, 2001);
      assert.equal(result.references.length, 2000);
      assert.equal(result.totalMissingReferences, 1);
      assert.deepEqual(result.missingReferences, [ids[2000]]);
      assert.equal(result.truncated, true);
      global.Editor.Message.request = async (_service, message) => {
        if (message === 'query-asset-info') return { uuid: 'many', url: 'db://assets/many.scene', type: 'cc.SceneAsset', file: sceneFile };
        if (message === 'query-assets') return ids.map((uuid) => ({ uuid, url: `db://assets/${uuid}.png` }));
        throw new Error(`unexpected ${message}`);
      };
      const clean = await new AdvancedCapabilityTools().sceneReferenceValidate({ reference: { id: 'many' } });
      assert.equal(clean.valid, true);
      assert.equal(clean.truncated, true);
      assert.equal(clean.totalMissingReferences, 0);
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('reports prefab reference audit truncation and nested prefabs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-prefab-ref-'));
    const file = path.join(root, 'root.prefab');
    const nestedUuid = '44444444-4444-4444-4444-444444444444';
    const missingUuid = '99999999-9999-9999-9999-999999999999';
    fs.writeFileSync(file, JSON.stringify({ nested: nestedUuid, broken: missingUuid }));
    const previous = global.Editor;
    global.Editor = { Message: { request: async (service, message, identifier) => {
      if (service !== 'asset-db') throw new Error(`unexpected ${service}:${message}`);
      if (message === 'query-asset-info') return { uuid: 'root', url: 'db://assets/root.prefab', type: 'cc.Prefab', file };
      if (message === 'query-assets') return [{ uuid: nestedUuid, url: 'db://assets/nested.prefab' }];
      throw new Error(`unexpected asset-db message ${message}`);
    } } };
    try {
      const result = await new AdvancedCapabilityTools().prefabReferenceAudit({ reference: { id: 'root' }, maxReferences: 1 });
      assert.equal(result.totalReferences, 2);
      assert.equal(result.truncated, true);
      assert.equal(result.valid, false);
      assert.deepEqual(result.missingReferences, [{ id: missingUuid }]);
      assert.equal(result.totalMissingReferences, 1);
      const full = await new AdvancedCapabilityTools().prefabReferenceAudit({ reference: { id: 'root' } });
      assert.equal(full.totalReferences, 2);
      assert.equal(full.truncated, false);
      assert.deepEqual(full.nestedPrefabs, [{ uuid: nestedUuid, url: 'db://assets/nested.prefab' }]);
      assert.deepEqual(full.missingReferences, [{ id: missingUuid }]);
      assert.equal(full.valid, false);
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('returns prefab source hashes after a successful override apply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-prefab-apply-'));
    const file = path.join(root, 'fixture.prefab');
    fs.writeFileSync(file, '{"position":0}');
    const previous = global.Editor;
    const row = { uuid: 'prefab-asset', url: 'db://assets/fixture.prefab', type: 'cc.Prefab', file };
    global.Editor = { Message: { request: async (service, message) => {
      if (service === 'asset-db' && message === 'query-asset-info') return row;
      if (service === 'scene' && message === 'query-node') return { uuid: 'instance', __prefab__: { value: { uuid: 'prefab-asset' } }, name: { value: 'Fixture' } };
      if (service === 'scene' && message === 'execute-scene-script') { fs.writeFileSync(file, '{"position":7}'); return null; }
      if (service === 'scene' && message === 'snapshot') return true;
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const result = await new AdvancedCapabilityTools().prefabApplyOverrides({ reference: { id: 'instance', type: 'cc.Node' } });
      assert.equal(result.persisted, true);
      assert.equal(result.operation, 'apply');
      assert.notEqual(result.sourceReadBack.beforeSha256, result.sourceReadBack.afterSha256);
      assert.equal(result.sourceReadBack.url, 'db://assets/fixture.prefab');
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('instantiates prefab with linked identity and cleans failed read-back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-prefab-instantiate-'));
    const file = path.join(root, 'fixture.prefab');
    fs.writeFileSync(file, '{}');
    const previous = global.Editor;
    let removed = false;
    const row = { uuid: 'prefab-asset', url: 'db://assets/fixture.prefab', type: 'cc.Prefab', file };
    global.Editor = { Message: { request: async (service, message, argument) => {
      if (service === 'asset-db' && message === 'query-asset-info') return row;
      if (service === 'scene' && message === 'query-node-tree') return { uuid: 'root' };
      if (service === 'scene' && message === 'create-node') return 'instance';
      if (service === 'scene' && message === 'snapshot') return true;
      if (service === 'scene' && message === 'query-node') return argument === 'instance' ? { uuid: 'instance', __prefab__: { value: { uuid: 'prefab-asset' } } } : { uuid: 'root' };
      if (service === 'scene' && message === 'remove-node') { removed = true; return true; }
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const result = await new AdvancedCapabilityTools().prefabInstantiate({ reference: { id: 'prefab-asset', type: 'cc.Prefab' }, name: 'FixtureInstance' });
      assert.equal(result.persisted, true);
      assert.equal(result.reference.id, 'instance');
      assert.equal(result.source.id, 'prefab-asset');
      assert.equal(removed, false);
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts Creator 3.7 query-node prefab identity fields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-prefab-3x7-'));
    const file = path.join(root, 'fixture.prefab');
    fs.writeFileSync(file, '{}');
    const previous = global.Editor;
    const row = { uuid: 'prefab-3x7', url: 'db://assets/fixture.prefab', type: 'cc.Prefab', file };
    global.Editor = { Message: { request: async (service, message) => {
      if (service === 'asset-db' && message === 'query-asset-info') return row;
      if (service === 'scene' && message === 'query-node-tree') return { uuid: 'scene-root' };
      if (service === 'scene' && message === 'create-node') return 'instance-3x7';
      if (service === 'scene' && message === 'snapshot') return true;
      if (service === 'scene' && message === 'query-node') return { uuid: { value: 'instance-3x7' }, prefab: { assetUuid: { value: 'prefab-3x7' } }, name: { value: 'Instance' } };
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const result = await new AdvancedCapabilityTools().prefabInstantiate({ reference: { id: row.uuid, type: 'cc.Prefab' } });
      assert.equal(result.persisted, true);
      assert.deepEqual(result.reference, { id: 'instance-3x7', type: 'cc.Node' });
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips the native reference-image lifecycle without claiming unsupported configuration', async () => {
    const previous = global.Editor;
    const requests = [];
    global.Editor = { Message: { request: async (service, message, payload) => {
      requests.push([service, message, payload]);
      if (service !== 'scene') throw new Error(`unexpected ${service}:${message}`);
      if (message === 'set-reference-image') return true;
      if (message === 'query-reference-image') return { id: 'image-asset', path: 'db://assets/reference.png' };
      if (message === 'list-reference-images') return [{ id: 'image-asset', path: 'db://assets/reference.png' }];
      if (message === 'clear-reference-image') return true;
      throw new Error(`unexpected scene message ${message}`);
    } } };
    try {
      const tools = new AdvancedCapabilityTools();
      const set = await tools.referenceImageManage({ operation: 'set', imagePath: 'db://assets/reference.png' });
      assert.deepEqual(set, { operation: 'set', supported: true, persisted: true, imagePath: 'db://assets/reference.png', reference: null, images: undefined, result: true });
      const inspect = await tools.referenceImageManage({ operation: 'inspect' });
      assert.equal(inspect.supported, true);
      assert.equal(inspect.persisted, true);
      const listed = await tools.referenceImageManage({ operation: 'list' });
      assert.deepEqual(listed.images, [{ id: 'image-asset', path: 'db://assets/reference.png' }]);
      const clear = await tools.referenceImageManage({ operation: 'clear' });
      assert.equal(clear.persisted, true);
      assert.deepEqual(requests.map(([, message]) => message), ['set-reference-image', 'query-reference-image', 'list-reference-images', 'clear-reference-image']);
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
    }
  });

  it('switches and refreshes the bounded reference-image lifecycle', async () => {
    const previous = global.Editor;
    let current = null;
    global.Editor = { Message: { request: async (service, message, payload) => {
      if (service !== 'scene') throw new Error(`unexpected ${service}:${message}`);
      if (message === 'set-reference-image') { current = { id: payload.uuid ?? 'image-asset', path: payload.path }; return true; }
      if (message === 'query-reference-image') return current;
      if (message === 'clear-reference-image') { current = null; return true; }
      throw new Error(`unexpected scene message ${message}`);
    } } };
    try {
      const tools = new AdvancedCapabilityTools();
      const switched = await tools.referenceImageManage({ operation: 'switch', imagePath: 'db://assets/reference-2.png', reference: { id: 'image-2', type: 'cc.ImageAsset' } });
      assert.equal(switched.persisted, true);
      assert.equal(switched.imagePath, 'db://assets/reference-2.png');
      const refreshed = await tools.referenceImageManage({ operation: 'refresh' });
      assert.equal(refreshed.persisted, true);
      assert.equal(refreshed.imagePath, 'db://assets/reference-2.png');
      await tools.referenceImageManage({ operation: 'clear' });
      await assert.rejects(() => tools.referenceImageManage({ operation: 'refresh' }), error => error.code === 'TARGET_NOT_FOUND');
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
    }
  });

  it('uses only the qualified project-profile fallback for persistent reference-image lifecycle', async () => {
    const previous = global.Editor;
    const profile = {};
    const row = { uuid: 'image-asset', url: 'db://assets/reference.png', type: 'cc.Texture2D', file: __filename };
    global.Editor = {
      Message: { request: async (service, message) => {
        if (service === 'scene' && message === 'query-current-scene') return { uuid: 'scene-asset' };
        throw new Error(`unsupported ${service}:${message}`);
      } },
      Profile: {
        getProject: async () => ({ ...profile }),
        setProject: async (_packageName, _key, value) => { Object.keys(profile).forEach((key) => delete profile[key]); Object.assign(profile, value); },
      },
    };
    const originalRequest = global.Editor.Message.request;
    global.Editor.Message.request = async (service, message, payload) => {
      if (service === 'asset-db' && message === 'query-asset-info') return row;
      return originalRequest(service, message, payload);
    };
    try {
      const tools = new AdvancedCapabilityTools();
      const set = await tools.referenceImageManage({ operation: 'set', imagePath: row.url });
      assert.equal(set.persisted, true);
      assert.deepEqual(set.reference, { id: row.uuid, type: 'cc.ImageAsset' });
      const inspect = await tools.referenceImageManage({ operation: 'inspect' });
      assert.equal(inspect.imagePath, row.url);
      assert.deepEqual(inspect.reference, { id: row.uuid, type: 'cc.ImageAsset' });
      const listed = await tools.referenceImageManage({ operation: 'list' });
      assert.equal(listed.persisted, true);
      assert.equal(listed.images.length, 1);
      const clear = await tools.referenceImageManage({ operation: 'clear' });
      assert.equal(clear.persisted, true);
      assert.deepEqual(profile, {});
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
    }
  });

  it('returns bounded CCP listener inspection without inventing arbitrary listeners', async () => {
    const result = await new AdvancedCapabilityTools().editorListenersInspect();
    assert.equal(result.supported, true);
    assert.deepEqual(result.listeners, []);
    assert.match(result.limitation, /arbitrary listener enumeration/);
  });

  it('rejects selective prefab revert when Creator exposes only full restore', async () => {
    await assert.rejects(
      () => new AdvancedCapabilityTools().prefabRevertOverrides({ reference: { id: 'instance', type: 'cc.Node' }, paths: ['position'] }),
      (error) => error.code === 'UNSUPPORTED_SELECTIVE_REVERT' && error.status === 422,
    );
  });
  it('restores a prefab instance through native full restore and reads back identity', async () => {
    const previous = global.Editor;
    const requests = [];
    global.Editor = { Message: { request: async (service, message, payload) => {
      requests.push([service, message, payload]);
      if (service === 'scene' && message === 'query-node') return { uuid: 'instance', __prefab__: { value: { uuid: 'prefab-asset' } } };
      if (service === 'asset-db' && message === 'query-asset-info') return { uuid: 'prefab-asset', url: 'db://assets/fixture.prefab', type: 'cc.Prefab', file: __filename };
      if (service === 'scene' && message === 'restore-prefab') return true;
      if (service === 'scene' && message === 'snapshot') return true;
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const result = await new AdvancedCapabilityTools().prefabRestore({ reference: { id: 'instance', type: 'cc.Node' } });
      assert.equal(result.operation, 'revert');
      assert.equal(result.persisted, true);
      assert.ok(requests.some(([, message]) => message === 'restore-prefab'));
      // Creator 3.7 only reverts when the node UUID arrives as the positional argument.
      const restoreCall = requests.find(([, message]) => message === 'restore-prefab');
      assert.equal(restoreCall[2], 'instance');
      assert.deepEqual(result.reference, { id: 'instance', type: 'cc.Node' });
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
    }
  });
  it('creates prefab from node, updates linked instance, and inspects overrides', async () => {
    const previous = global.Editor;
    const file = __filename;
    const requests = [];
    global.Editor = { Message: { request: async (service, message, payload) => {
      requests.push([service, message, payload]);
      if (service === 'scene' && message === 'query-node' && payload === 'node') return { uuid: 'node', __prefab__: { value: { uuid: 'prefab-asset', instance: { propertyOverrides: [{ path: 'name', value: 'Changed' }] } } } };
      if (service === 'scene' && message === 'execute-scene-script') return 'created-prefab';
      if (service === 'asset-db' && message === 'query-asset-info') return { uuid: 'created-prefab', url: 'db://assets/created.prefab', type: 'cc.Prefab', file };
      if (service === 'scene' && message === 'snapshot') return true;
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const tools = new AdvancedCapabilityTools();
      const created = await tools.prefabCreateFromNode({ reference: { id: 'node', type: 'cc.Node' }, assetPath: 'db://assets/created.prefab' });
      assert.equal(created.persisted, true);
      assert.equal(created.asset.id, 'created-prefab');
      global.Editor.Message.request = async (service, message, payload) => {
        // Creator 3.7 serializes __prefab__.instance as a property descriptor.
        if (service === 'scene' && message === 'query-node') return { uuid: 'node', __prefab__: { uuid: 'prefab-asset', instance: { value: { propertyOverrides: [{ propertyPath: ['_lscale'], value: { x: 2, y: 2, z: 2 } }] }, type: 'cc.PrefabInfo' } } };
        if (service === 'asset-db' && message === 'query-asset-info') return { uuid: 'prefab-asset', url: 'db://assets/fixture.prefab', type: 'cc.Prefab', file };
        if (service === 'scene' && message === 'execute-scene-script') return null;
        if (service === 'scene' && message === 'snapshot') return true;
        throw new Error(`unexpected ${service}:${message}`);
      };
      await assert.doesNotReject(() => tools.prefabUpdate({ reference: { id: 'node', type: 'cc.Node' } }));
      const inspected = await tools.prefabInstanceInspect({ reference: { id: 'node', type: 'cc.Node' } });
      assert.equal(inspected.isPrefabInstance, true);
      assert.equal(inspected.prefabReference.id, 'prefab-asset');
      assert.equal(inspected.overrides.length, 1);
      assert.deepEqual(inspected.overrides[0].propertyPath, ['_lscale']);
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
    }
  });
  it('returns prefab info and validates serialized dependencies with read-back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-prefab-validate-'));
    const file = path.join(root, 'fixture.prefab');
    fs.writeFileSync(file, JSON.stringify({ __type__: 'cc.Node', child: { __type__: 'cc.Sprite', asset: '11111111-1111-1111-1111-111111111111@sub' } }));
    const previous = global.Editor;
    const row = { uuid: 'prefab-asset', url: 'db://assets/fixture.prefab', type: 'cc.Prefab', file };
    global.Editor = { Message: { request: async (service, message) => {
      if (service === 'asset-db' && message === 'query-asset-info') return row;
      if (service === 'asset-db' && message === 'query-assets') return [row];
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const tools = new PrefabJsonTools();
      const info = await tools.prefabInfo({ reference: { id: 'prefab-asset', type: 'cc.Prefab' } });
      assert.equal(info.totalEntries, 2);
      const validation = await tools.prefabValidate({ reference: { id: 'prefab-asset', type: 'cc.Prefab' } });
      assert.equal(validation.valid, false);
      assert.deepEqual(validation.missingReferences, [{ id: '11111111-1111-1111-1111-111111111111' }]);
      assert.equal(validation.issues[0].code, 'MISSING_REFERENCE');
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });


  it('registers all bounded prefab, tilemap, UI, and ergonomics routes', () => {
    const names = new Set(ToolRegistry.getTools().map(({ tool }) => tool.name));
    for (const name of [
      'prefabInfo', 'prefabValidate',
      'referenceImageManage', 'prefabOverrideDiff', 'prefabReferenceAudit', 'sceneReferenceValidate',
      'prefabInstantiate', 'prefabCreateFromNode', 'prefabUpdate', 'prefabInstanceInspect', 'prefabApplyOverrides', 'prefabRevertOverrides', 'prefabRestore', 'tilemapInspect',
      'tilemapLayerEdit', 'tilemapObjectEdit', 'tilemapValidate', 'spriteAtlasConfigure',
      'uiResponsivePreview', 'previewResolutionSet', 'editorUndoTransactionProbe', 'broadcastObserve',
    ]) assert.ok(names.has(name), name);
  });

  it('returns typed unsupported evidence for unavailable preview IPC', async () => {
    const previous = global.Editor;
    global.Editor = { Message: { request: async () => { throw new Error('unsupported'); } } };
    try {
      await assert.rejects(
        () => new AdvancedCapabilityTools().previewResolutionSet({ width: 800, height: 600 }),
        (error) => error.code === 'UNSUPPORTED_PREVIEW_IPC' && error.status === 422,
      );
    } finally {
      if (previous === undefined) delete global.Editor;
      else global.Editor = previous;
    }
  });
  it('resolves a UI reference beyond 128 scene nodes and rejects a genuinely missing ID', async () => {
    const previous = global.Editor;
    const children = Array.from({ length: 211 }, (_, index) => ({ uuid: `sibling-${index}`, children: [] }));
    children.push({ uuid: 'target-beyond-128', children: [] });
    global.Editor = { Message: { request: async (service, message, payload) => {
      if (service === 'scene' && message === 'query-node-tree') return { uuid: 'current-root', children };
      if (service === 'scene' && message === 'execute-scene-script') {
        assert.deepEqual(payload.args, [{ nodeIds: ['target-beyond-128'] }]);
        return { nodes: [{ id: 'target-beyond-128', worldRect: { x: 0, y: 0, width: 64, height: 32 } }] };
      }
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const preview = await new AdvancedCapabilityTools().uiResponsivePreview({ reference: { id: 'target-beyond-128', type: 'cc.Node' }, resolutions: [{ width: 1280, height: 720 }] });
      assert.equal(preview.supported, true);
      assert.equal(preview.comparisons[0].projectedRects[0].id, 'target-beyond-128');
      await assert.rejects(
        () => new AdvancedCapabilityTools().uiResponsivePreview({ reference: { id: 'missing-node', type: 'cc.Node' }, resolutions: [{ width: 1280, height: 720 }] }),
        error => error.code === 'TARGET_NOT_FOUND' && error.status === 404 && /nodeGetTree/.test(error.recovery),
      );
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
    }
  });
  it('does not claim a UI node is missing when the 2000-node search bound is reached', async () => {
    const previous = global.Editor;
    global.Editor = { Message: { request: async (service, message) => {
      if (service === 'scene' && message === 'query-node-tree') return { uuid: 'root', children: Array.from({ length: 2000 }, (_, index) => ({ uuid: `node-${index}`, children: [] })) };
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      await assert.rejects(
        () => new AdvancedCapabilityTools().uiResponsivePreview({ reference: { id: 'outside-bound', type: 'cc.Node' }, resolutions: [{ width: 1280, height: 720 }] }),
        error => error.code === 'SCENE_LOOKUP_LIMIT' && error.status === 422 && error.details.maxNodes === 2000,
      );
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
    }
  });
  it('publishes expansion integration guidance in agent-visible descriptions', () => {
    const metadata = ToolRegistry.getTools().find(({ tool }) => tool.name === 'prefabOverrideDiff');
    assert.ok(metadata);
    assert.match(metadata.tool.description, /Integration guidance — Use when:/);
    assert.match(metadata.tool.description, /Preconditions:/);
    assert.match(metadata.tool.description, /verify the returned postcondition/);
  });
});
