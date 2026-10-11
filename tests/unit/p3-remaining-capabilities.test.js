'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist, readSource } = require('../helpers/require-dist');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PortfolioValidationTools } = requireDist('utcp/tools/portfolio-validation-tools.js');

let previousEditor;
afterEach(() => {
  global.Editor = previousEditor;
  previousEditor = undefined;
});

function install(request) {
  previousEditor = global.Editor;
  global.Editor = { Message: { request } };
}

function asset(id, metadata = {}) {
  return { uuid: id, type: 'cc.FBX', url: `db://assets/${id}.fbx`, meta: { userData: metadata } };
}

describe('remaining P3 capability contracts', () => {

  it('creates an animation graph only after asset-db identity read-back', async () => {
    const calls = [];
    install(async (service, message, ...args) => {
      calls.push({ service, message, args });
      if (message === 'generate-available-url') return 'db://assets/graphs/walk.animgraph';
      if (message === 'copy-asset') return { uuid: 'graph-uuid', type: 'cc.AnimationGraph', url: args[1] };
      if (message === 'query-asset-info') return { uuid: 'graph-uuid', type: 'cc.AnimationGraph', url: 'db://assets/graphs/walk.animgraph' };
      throw new Error(`unexpected ${service}:${message}`);
    });

    const result = await new PortfolioValidationTools().animationGraphCreate({ assetPath: 'db://assets/graphs/walk' });
    assert.deepEqual(result, {
      reference: { id: 'graph-uuid', type: 'cc.AnimationGraph' },
      assetPath: 'db://assets/graphs/walk.animgraph',
      verified: true,
    });
    assert.deepEqual(calls.map((call) => call.message), ['generate-available-url', 'copy-asset', 'query-asset-info']);
    assert.equal(calls[1].args[0], 'db://internal/default_file_content/animgraph');
  });

  it('rejects unsafe graph paths and refuses success without identity', async () => {
    const calls = [];
    install(async (...args) => { calls.push(args); return null; });
    const tools = new PortfolioValidationTools();
    await assert.rejects(() => tools.animationGraphCreate({ assetPath: 'db://assets/../outside' }), (error) => error.code === 'INVALID_ARGUMENT' && error.status === 400);
    assert.deepEqual(calls, []);

    install(async (_service, message) => {
      if (message === 'generate-available-url') return 'db://assets/graphs/empty.animgraph';
      if (message === 'copy-asset') return { type: 'cc.AnimationGraph' };
      throw new Error('unexpected request');
    });
    await assert.rejects(() => tools.animationGraphCreate({ assetPath: 'db://assets/graphs/empty' }), (error) => error.code === 'CREATE_FAILED' && error.status === 502);
  });
  it('refuses synthetic graph edits before any source save', async () => {
    const file = path.join(os.tmpdir(), `animgraph-${process.pid}-${Date.now()}.json`);
    const original = JSON.stringify({ nodes: [{ id: 'idle' }], transitions: [] });
    fs.writeFileSync(file, original);
    let writes = 0;
    install(async (_service, message) => {
      if (message === 'query-asset-info') return { uuid: 'graph', type: 'cc.AnimationGraph', url: 'db://assets/graphs/test.animgraph', file };
      writes++;
      throw new Error(`unexpected mutation ${message}`);
    });
    try {
      await assert.rejects(() => new PortfolioValidationTools().animationGraphEdit({ reference: { id: 'graph' }, operations: [{ operation: 'add_node', node: { id: 'run' } }] }), error => error.code === 'UNSUPPORTED_GRAPH_FORMAT');
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      assert.equal(writes, 0);
    } finally { fs.rmSync(file, { force: true }); }
  });

  it('rejects unsafe terrain paths before asset creation', async () => {
    const calls = [];
    install(async (...args) => { calls.push(args); throw new Error('asset IPC must not run'); });
    await assert.rejects(
      () => new PortfolioValidationTools().terrainCreate({ assetPath: 'db://assets/../unsafe.terrain', name: 'UnsafeTerrain' }),
      (error) => error.code === 'INVALID_ARGUMENT' && error.status === 400,
    );
    assert.deepEqual(calls, []);
  });

  it('compares bounded skeleton and clip metadata without claiming automatic retargeting', async () => {
    install(async (_service, message, id) => {
      if (message !== 'query-asset-info') throw new Error('unexpected request');
      if (id === 'source') return asset('source', { joints: ['root', 'hip'], clips: ['idle'], skeletonId: 'shared-skeleton' });
      if (id === 'target') return asset('target', { joints: ['root', 'hip'], clips: ['idle'], skeletonId: 'shared-skeleton' });
      return id === 'other' ? asset(id, { joints: ['root'], clips: ['idle'], skeletonId: 'target-skeleton' }) : asset(id, { joints: ['root', 'hip'], clips: ['idle'], skeletonId: 'shared-skeleton' });
    });

    const result = await new PortfolioValidationTools().animationRetargetValidate({
      sourceReference: { id: 'source', type: 'cc.FBX' },
      targetReference: { id: 'target', type: 'cc.FBX' },
      clipReference: { id: 'clip', type: 'cc.AnimationClip' },
    });
    assert.equal(result.valid, true);
    assert.equal(result.automaticRetargeting, false);
    assert.deepEqual(result.source.joints, ['root', 'hip']);
    assert.deepEqual(result.target.joints, ['root', 'hip']);
    assert.deepEqual(result.clip.clips, ['idle']);
    assert.equal(result.clip.skeletonId, 'shared-skeleton');

    const mismatch = await new PortfolioValidationTools().animationRetargetValidate({
      sourceReference: { id: 'source' },
      targetReference: { id: 'other' },
    });
    assert.equal(mismatch.valid, false);
    assert.equal(mismatch.issues[0].code, 'TARGET_JOINTS_MISSING');
  });

  it('fails closed when retarget metadata is unavailable', async () => {
    install(async () => asset('model', {}));
    await assert.rejects(
      () => new PortfolioValidationTools().animationRetargetValidate({ sourceReference: { id: 'model' }, targetReference: { id: 'model' } }),
      (error) => error.code === 'UNSUPPORTED_METADATA' && error.status === 422,
    );
  });
  it('reads imported gltf-skeleton subasset JSON when model metadata exposes the file', async () => {
    const skeletonFile = path.join(os.tmpdir(), `ccp-skeleton-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(skeletonFile, JSON.stringify({ __type__: 'cc.Skeleton', _joints: ['root', 'hip', 'hand'] }));
    install(async (_service, message, id) => {
      if (message !== 'query-asset-info') throw new Error('unexpected request');
      return {
        uuid: id,
        type: 'cc.FBX',
        importer: 'fbx',
        subAssets: { skeleton: { importer: 'gltf-skeleton', file: skeletonFile, uuid: `${id}@skeleton` } },
      };
    });
    try {
      const result = await new PortfolioValidationTools().animationRetargetValidate({ sourceReference: { id: 'source' }, targetReference: { id: 'target' } });
      assert.deepEqual(result.source.joints, ['root', 'hip', 'hand']);
      assert.deepEqual(result.target.joints, ['root', 'hip', 'hand']);
      assert.equal(result.valid, true);
    } finally {
      fs.rmSync(skeletonFile, { force: true });
    }
  });
  it('reads imported gltf-skeleton JSON through the library map when Creator leaves file empty', async () => {
    const skeletonFile = path.join(os.tmpdir(), `ccp-skeleton-lib-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(skeletonFile, JSON.stringify({ __type__: 'cc.Skeleton', _joints: ['Armature/boneA', 'Armature/boneA/boneB'] }));
    install(async (_service, message, id) => {
      if (message !== 'query-asset-info') throw new Error('unexpected request');
      return {
        uuid: id,
        type: 'cc.Asset',
        importer: 'gltf',
        // Creator 3.7 reports file:'' for imported sub-assets and exposes the emitted JSON
        // through the library extension map instead.
        subAssets: { skeleton: { importer: 'gltf-skeleton', type: 'cc.Skeleton', file: '', library: { '.json': skeletonFile }, uuid: `${id}@skeleton` } },
      };
    });
    try {
      const result = await new PortfolioValidationTools().animationRetargetValidate({ sourceReference: { id: 'source' }, targetReference: { id: 'target' } });
      assert.deepEqual(result.source.joints, ['Armature/boneA', 'Armature/boneA/boneB']);
      assert.deepEqual(result.target.joints, ['Armature/boneA', 'Armature/boneA/boneB']);
      assert.equal(result.valid, true);
      assert.equal(result.automaticRetargeting, false);
    } finally {
      fs.rmSync(skeletonFile, { force: true });
    }
  });
  it('lists bounded imported model outputs with stable subasset identities', async () => {
    install(async (_service, message, id) => {
      if (message !== 'query-asset-info') throw new Error('unexpected request');
      return { uuid: id, type: 'cc.FBX', importer: 'fbx', subAssets: { mesh: { uuid: `${id}@mesh`, importer: 'gltf-mesh', type: 'cc.Mesh', name: 'Body' }, skeleton: { uuid: `${id}@skeleton`, importer: 'gltf-skeleton', type: 'cc.Skeleton', name: 'Rig' } } };
    });
    const result = await new PortfolioValidationTools().modelImportOutputsInspect({ reference: { id: 'model' }, maxOutputs: 1 });
    assert.equal(result.total, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.outputs[0], { uuid: 'model@mesh', url: null, type: 'cc.Mesh', importer: 'gltf-mesh', name: 'Body', userData: null });
  });
  it('validates imported model skeleton joint uniqueness', async () => {
    install(async (_service, message, id) => {
      if (message !== 'query-asset-info') throw new Error('unexpected request');
      return { uuid: id, type: 'cc.FBX', importer: 'fbx', meta: { userData: { joints: ['root', 'hip', 'hand'], skeletonId: 'rig' } } };
    });
    const result = await new PortfolioValidationTools().modelSkeletonValidate({ reference: { id: 'model' } });
    assert.equal(result.valid, true);
    assert.equal(result.jointCount, 3);
    assert.equal(result.skeletonId, 'rig');
  });

  it('inspects imported model animation clips with bounded metadata', async () => {
    install(async (_service, message, id) => {
      if (message !== 'query-asset-info') throw new Error('unexpected request');
      return { uuid: id, type: 'cc.FBX', importer: 'fbx', meta: { userData: { animationImportSettings: [{ name: 'idle' }, { name: 'run' }], skeletonId: 'rig' } } };
    });
    const result = await new PortfolioValidationTools().modelAnimationInspect({ reference: { id: 'model' }, maxClips: 1 });
    assert.deepEqual(result.clips, ['idle']);
    assert.equal(result.totalClips, 2);
    assert.equal(result.truncated, true);
  });

  it('validates imported model animation clip names', async () => {
    install(async (_service, message, id) => {
      if (message !== 'query-asset-info') throw new Error('unexpected request');
      return { uuid: id, type: 'cc.FBX', importer: 'fbx', meta: { userData: { clips: ['idle', 'run'], skeletonId: 'rig' } } };
    });
    const result = await new PortfolioValidationTools().modelAnimationValidate({ reference: { id: 'model' } });
    assert.equal(result.valid, true);
    assert.equal(result.clipCount, 2);
  });

  it('configures only serialized skeletal fields and verifies read-back', async () => {
    const calls = [];
    const node = {
      uuid: 'skeletal-node',
      __comps__: [{ type: 'cc.SkeletalAnimation', value: { uuid: { value: 'skeletal-component' }, playOnLoad: { value: false, type: 'Boolean' } } }],
    };
    install(async (service, message, payload) => {
      calls.push({ service, message, payload });
      if (message === 'query-node') return node;
      if (message === 'set-property') {
        node.__comps__[0].value.playOnLoad = payload.dump;
        return true;
      }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${service}:${message}`);
    });

    const result = await new PortfolioValidationTools().skeletalAnimationConfigure({
      reference: { id: 'skeletal-node', type: 'cc.Node' },
      properties: { playOnLoad: true },
    });
    assert.deepEqual(result.reference, { id: 'skeletal-node', type: 'cc.Node' });
    assert.deepEqual(result.componentReference, { id: 'skeletal-component', type: 'cc.SkeletalAnimation' });
    assert.deepEqual(result.properties, { playOnLoad: true });
    assert.deepEqual(result.changed, ['playOnLoad']);
    assert.equal(result.verified, true);
    assert.deepEqual(calls.map((call) => call.message), ['query-node', 'set-property', 'snapshot', 'query-node']);
  });
  it('rolls back skeletal fields after stale read-back and confirms restoration', async () => {
    const node = {
      uuid: 'skeletal-node',
      __comps__: [{ type: 'cc.SkeletalAnimation', value: { uuid: { value: 'skeletal-component' }, playOnLoad: { value: false, type: 'Boolean' } } }],
    };
    let queryCount = 0;
    install(async (_service, message, payload) => {
      if (message === 'query-node') {
        queryCount += 1;
        if (queryCount === 2) return { uuid: 'skeletal-node', __comps__: [{ type: 'cc.SkeletalAnimation', value: { uuid: { value: 'skeletal-component' }, playOnLoad: { value: false, type: 'Boolean' } } }] };
        return node;
      }
      if (message === 'set-property') { node.__comps__[0].value.playOnLoad = payload.dump; return true; }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    });
    await assert.rejects(
      () => new PortfolioValidationTools().skeletalAnimationConfigure({ reference: { id: 'skeletal-node' }, properties: { playOnLoad: true } }),
      error => error.code === 'MUTATION_FAILED' && error.status === 502,
    );
    assert.equal(node.__comps__[0].value.playOnLoad.value, false);
    assert.equal(queryCount, 3);
  });

  it('rejects unsupported skeletal fields before scene mutation', async () => {
    const calls = [];
    install(async (...args) => { calls.push(args); throw new Error('scene IPC must not run'); });
    await assert.rejects(
      () => new PortfolioValidationTools().skeletalAnimationConfigure({ reference: { id: 'node' }, properties: { skin: 'hero' } }),
      (error) => error.code === 'UNSUPPORTED_PROPERTY' && error.status === 422,
    );
    assert.deepEqual(calls, []);
  });

  it('reads bundle metadata from the asset-db metadata channel', async () => {
    const calls = [];
    install(async (service, message, id) => {
      calls.push({ service, message, id });
      if (message === 'query-asset-info') return { uuid: id, type: 'cc.Asset', url: 'db://assets/__bundle__' };
      if (message === 'query-asset-meta') return { userData: { isBundle: true, bundleName: 'ccp3x-qualification', priority: 10, compressionType: { web: 'merge_dep' }, isRemoteBundle: { web: false } } };
      throw new Error(`unexpected ${service}:${message}`);
    });
    const result = await new PortfolioValidationTools().assetBundleValidate({ reference: { id: 'bundle-folder', type: 'cc.Asset' }, expectedBundle: 'ccp3x-qualification' });
    assert.equal(result.valid, true);
    assert.deepEqual(result.bundle, { name: 'ccp3x-qualification', priority: 10, compressionType: { web: 'merge_dep' }, remote: { web: false } });
    assert.deepEqual(calls.map((call) => call.message), ['query-asset-info', 'query-asset-meta']);
  });
});
