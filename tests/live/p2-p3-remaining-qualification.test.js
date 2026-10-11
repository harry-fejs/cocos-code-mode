'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getJson, postTool, repeatTestcase, healthCheck } = require('../helpers/utcp-client');

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Minimal skinned glTF 2.0 with an embedded buffer. Variant content is driven only by the
// joint names, which is what animationRetargetValidate compares.
function buildSkinnedGltf(jointNames) {
  const jointCount = jointNames.length;
  const parts = [];
  let offset = 0;
  const add = (typedArray) => {
    const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const start = offset;
    parts.push(bytes);
    offset += bytes.length;
    const padded = (offset + 3) & ~3;
    if (padded > offset) { parts.push(Buffer.alloc(padded - offset)); offset = padded; }
    return start;
  };
  const positionOffset = add(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const jointsOffset = add(new Uint8Array(12));
  const weightsOffset = add(Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const indicesOffset = add(Uint16Array.from([0, 1, 2]));
  const inverseBind = new Float32Array(jointCount * 16);
  for (let joint = 0; joint < jointCount; joint++) inverseBind.set(IDENTITY_MATRIX, joint * 16);
  const ibmOffset = add(inverseBind);
  const buffer = Buffer.concat(parts);

  const nodes = [{ name: 'Armature', children: [1] }];
  const skeletonJoints = [];
  jointNames.forEach((name, index) => {
    skeletonJoints.push(index + 1);
    nodes.push({ name, ...(index + 1 < jointCount ? { children: [index + 2] } : {}), translation: [0, 1, 0] });
  });
  nodes.push({ name: 'Mesh', mesh: 0, skin: 0 });

  return {
    asset: { version: '2.0', generator: 'ccp3x-retarget-witness' },
    scene: 0,
    scenes: [{ nodes: [0, jointCount + 1] }],
    nodes,
    skins: [{ joints: skeletonJoints, inverseBindMatrices: 0, skeleton: skeletonJoints[0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 4 }] }],
    accessors: [
      { bufferView: 4, componentType: 5126, count: jointCount, type: 'MAT4' },
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: positionOffset, byteLength: 36 },
      { buffer: 0, byteOffset: jointsOffset, byteLength: 12 },
      { buffer: 0, byteOffset: weightsOffset, byteLength: 48 },
      { buffer: 0, byteOffset: indicesOffset, byteLength: 6 },
      { buffer: 0, byteOffset: ibmOffset, byteLength: jointCount * 64 },
    ],
    buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
  };
}

// Live witnesses for the P2/P3 rows that were implemented and unit-tested but had no
// exact-artifact qualification evidence. Fixtures are created inside db://assets and
// removed in finally blocks so the active Creator project is not mutated permanently.
describe('live: P2/P3 remaining candidate qualification witnesses', () => {
  let health;
  before(async () => { health = await healthCheck(); });

  function skipIfDown(t) {
    if (health?.ok) return false;
    t.skip(`editor not running: ${health?.reason ?? 'unknown'}`);
    return true;
  }

  const refQuery = (reference) => `reference%5Bid%5D=${encodeURIComponent(reference.id)}`;

  async function removeSceneNode(name) {
    return postTool('executeJavascript', {
      context: 'scene',
      code: `const n=cc.director.getScene().getChildByName('${name}');if(n){n.removeFromParent();n.destroy();}return true;`,
    });
  }

  async function snapshotScene() {
    return postTool('executeJavascript', { context: 'editor', code: `await Editor.Message.request('scene','snapshot');return true;` });
  }

  // Creator replaces the source node while materialising a prefab asset, so the scene
  // identity returned by the creating call is stale and must be re-resolved by name.
  async function resolveSceneNodeByName(name) {
    const found = await postTool('executeJavascript', {
      context: 'scene',
      code: `const n=cc.director.getScene().getChildByName('${name}');return n?{uuid:n.uuid,name:n.name}:null;`,
    });
    if (found.status !== 200 || typeof found.body?.result?.uuid !== 'string') {
      throw new Error(`Scene node ${name} could not be re-resolved: ${JSON.stringify(found.body)}`);
    }
    return { id: found.body.result.uuid, type: 'cc.Node' };
  }

  async function readSceneState(name) {
    const found = await postTool('executeJavascript', {
      context: 'scene',
      code: `const n=cc.director.getScene().getChildByName('${name}');return n?{scale:{x:n.scale.x,y:n.scale.y,z:n.scale.z},active:n.active}:null;`,
    });
    if (found.status !== 200 || !found.body?.result) throw new Error(`Scene node ${name} has no transform: ${JSON.stringify(found.body)}`);
    return found.body.result;
  }

  async function readSceneOverrideCount(name) {
    const found = await postTool('executeJavascript', {
      context: 'scene',
      code: `const n=cc.director.getScene().getChildByName('${name}');const inst=n&&n._prefab&&n._prefab.instance;const list=inst&&Array.isArray(inst.propertyOverrides)?inst.propertyOverrides:[];return list.length;`,
    });
    if (found.status !== 200 || typeof found.body?.result !== 'number') throw new Error(`Scene node ${name} has no prefab instance: ${JSON.stringify(found.body)}`);
    return found.body.result;
  }

  it('inspects native graph structure and refuses unsupported edits without changing source', async (t) => {
    if (skipIfDown(t)) return;
    const created = await postTool('animationGraphCreate', { assetPath: `db://assets/__ccp3x_native_graph_${process.pid}__` });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const reference = created.body.reference;
    try {
      const before = await getJson(`/tools/animationGraphInspect?${refQuery(reference)}`);
      assert.equal(before.status, 200, JSON.stringify(before.body));
      assert.equal(before.body.format, 'native-creator-3.7');
      assert.equal(before.body.semanticsVerified, false);
      assert.equal(before.body.runtimeVerified, false);
      const edited = await postTool('animationGraphEdit', { reference, operations: [{ operation: 'add_node', node: { id: 'fake' } }] });
      assert.equal(edited.status, 422, JSON.stringify(edited.body));
      assert.equal(edited.body.code, 'NATIVE_GRAPH_EDIT_UNSUPPORTED');
      const after = await getJson(`/tools/animationGraphInspect?${refQuery(reference)}`);
      assert.deepEqual(after.body.states, before.body.states);
      assert.deepEqual(after.body.transitions, before.body.transitions);
      const validated = await getJson(`/tools/animationGraphValidate?${refQuery(reference)}`);
      assert.equal(validated.body.valid, false);
    } finally { await postTool('assetOperate', { operation: 'delete', reference }); }
  });

  it('reverts and applies prefab instance overrides with source and instance read-back', async (t) => {
    if (skipIfDown(t)) return;
    await repeatTestcase('P23-V02', async ({ iteration }) => {
      const label = `__ccp3x_override_fixture_${process.pid}_${iteration}__`;
      const cloneLabel = `${label}_clone`;
      const assetPath = `db://assets/${label}.prefab`;
      let nodeReference;
      let prefabReference;
      try {
        const primitive = await postTool('nodeCreatePrimitive', { name: label, primitiveType: 'Cube' });
        assert.equal(primitive.status, 200, JSON.stringify(primitive.body));
        nodeReference = primitive.body.reference;

        // Own the prefab source inside db://assets so the witness never mutates db://internal.
        const linked = await postTool('prefabCreateFromNode', { reference: nodeReference, assetPath });
        assert.equal(linked.status, 200, JSON.stringify(linked.body));
        assert.equal(linked.body.persisted, true);
        assert.equal(linked.body.asset.url, assetPath);
        prefabReference = linked.body.asset;

        // The node is taken over by the new prefab asset, so its previous identity is dead.
        nodeReference = await resolveSceneNodeByName(label);
        const linkedInstance = await getJson(`/tools/prefabInstanceInspect?${refQuery(nodeReference)}`);
        assert.equal(linkedInstance.status, 200, JSON.stringify(linkedInstance.body));
        assert.equal(linkedInstance.body.isPrefabInstance, true);
        assert.equal(linkedInstance.body.prefabReference.id, prefabReference.id);

        // --- revert: an instance-only override must be discarded, not flushed to the source.
        const overridesBefore = await readSceneOverrideCount(label);
        const scaledForRevert = await postTool('nodeSetTransform', { reference: nodeReference, scale: { x: 3, y: 3, z: 3 } });
        assert.equal(scaledForRevert.status, 200, JSON.stringify(scaledForRevert.body));
        assert.deepEqual((await readSceneState(label)).scale, { x: 3, y: 3, z: 3 });
        assert.equal(await readSceneOverrideCount(label) > overridesBefore, true);

        const reverted = await postTool('prefabRevertOverrides', { reference: nodeReference });
        assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
        assert.equal(reverted.body.operation, 'revert');
        assert.equal(reverted.body.persisted, true);
        assert.equal(reverted.body.sourceReadBack.url, assetPath);
        // The instance returns to the prefab source value instead of keeping the override.
        assert.deepEqual((await readSceneState(label)).scale, { x: 1, y: 1, z: 1 });

        // --- apply: a new instance override must be flushed into the prefab source.
        // Creator keeps instance-root transform overrides on the instance, so the witness uses
        // a non-transform override, which applyPrefab does flush.
        const hiddenForApply = await postTool('nodeSetTransform', { reference: nodeReference, active: false });
        assert.equal(hiddenForApply.status, 200, JSON.stringify(hiddenForApply.body));
        assert.equal((await readSceneState(label)).active, false);
        const applied = await postTool('prefabApplyOverrides', { reference: nodeReference });
        assert.equal(applied.status, 200, JSON.stringify(applied.body));
        assert.equal(applied.body.operation, 'apply');
        assert.equal(applied.body.persisted, true);
        assert.equal(applied.body.sourceReadBack.url, assetPath);
        assert.match(String(applied.body.sourceReadBack.beforeSha256), /^[0-9a-f]{64}$/);
        assert.match(String(applied.body.sourceReadBack.afterSha256), /^[0-9a-f]{64}$/);
        assert.notEqual(applied.body.sourceReadBack.beforeSha256, applied.body.sourceReadBack.afterSha256);

        // A second instance of the same source proves the override reached the prefab asset.
        const clone = await postTool('prefabInstantiate', { reference: prefabReference, name: cloneLabel });
        assert.equal(clone.status, 200, JSON.stringify(clone.body));
        assert.equal((await readSceneState(cloneLabel)).active, false);

        // --- negatives.
        const selective = await postTool('prefabRevertOverrides', { reference: nodeReference, paths: ['_lscale'] });
        assert.equal(selective.status, 422, JSON.stringify(selective.body));
        assert.equal(selective.body.code, 'UNSUPPORTED_SELECTIVE_REVERT');

        const missing = await postTool('prefabApplyOverrides', { reference: { id: '__missing_prefab_instance__' } });
        assert.equal(missing.status, 404, JSON.stringify(missing.body));
        assert.equal(missing.body.code, 'TARGET_NOT_FOUND');
      } finally {
        await removeSceneNode(cloneLabel);
        await removeSceneNode(label);
        await snapshotScene();
        if (prefabReference) await postTool('assetOperate', { operation: 'delete', reference: prefabReference });
      }
    });
  });

  it('compares skeleton and clip metadata for retarget inputs', async (t) => {
    if (skipIfDown(t)) return;
    await repeatTestcase('P23-V03', async ({ iteration }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-retarget-'));
      const labelA = `__ccp3x_retarget_a_${process.pid}_${iteration}__`;
      const labelB = `__ccp3x_retarget_b_${process.pid}_${iteration}__`;
      const fileA = path.join(root, `${labelA}.gltf`);
      const fileB = path.join(root, `${labelB}.gltf`);
      fs.writeFileSync(fileA, JSON.stringify(buildSkinnedGltf(['boneA', 'boneB'])), 'utf8');
      fs.writeFileSync(fileB, JSON.stringify(buildSkinnedGltf(['boneA', 'boneB', 'boneC'])), 'utf8');
      const imported = await postTool('assetBatchImport', {
        items: [
          { sourceFilesystemPath: fileA, targetAssetPath: `db://assets/${labelA}.gltf` },
          { sourceFilesystemPath: fileB, targetAssetPath: `db://assets/${labelB}.gltf` },
        ],
      });
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
      const [twoJoint, threeJoint] = (imported.body.outcomes ?? []).map((outcome) => outcome.reference);
      assert.equal(typeof twoJoint?.id, 'string');
      assert.equal(typeof threeJoint?.id, 'string');
      const query = (source, target) => `/tools/animationRetargetValidate?sourceReference%5Bid%5D=${encodeURIComponent(source)}&targetReference%5Bid%5D=${encodeURIComponent(target)}`;
      try {
        // Identical skeletons are compatible and never claim automatic retargeting.
        const identical = await getJson(query(twoJoint.id, twoJoint.id));
        assert.equal(identical.status, 200, JSON.stringify(identical.body));
        assert.equal(identical.body.valid, true);
        assert.equal(identical.body.automaticRetargeting, false);
        assert.equal(identical.body.source.jointCount > 0, true);
        assert.equal(identical.body.source.jointCount, identical.body.target.jointCount);

        // A smaller source loses joints; a larger target adds them.
        const extra = await getJson(query(twoJoint.id, threeJoint.id));
        assert.equal(extra.status, 200, JSON.stringify(extra.body));
        assert.equal(extra.body.valid, false);
        assert.deepEqual(extra.body.issues.map((issue) => issue.code), ['TARGET_JOINTS_EXTRA']);

        const missing = await getJson(query(threeJoint.id, twoJoint.id));
        assert.equal(missing.status, 200, JSON.stringify(missing.body));
        assert.equal(missing.body.valid, false);
        assert.deepEqual(missing.body.issues.map((issue) => issue.code), ['TARGET_JOINTS_MISSING']);

        // An unknown reference fails closed before any comparison.
        const unknown = await getJson(query(twoJoint.id, '__missing_model__'));
        assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
        assert.equal(unknown.body.code, 'TARGET_NOT_FOUND');
      } finally {
        for (const reference of [twoJoint, threeJoint]) await postTool('assetOperate', { operation: 'delete', reference });
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
