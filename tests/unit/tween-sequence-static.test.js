'use strict';
const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');
const { TweenSequenceTools } = requireDist('utcp/tools/tween-sequence-tools.js');
const { generateTweenCode, requireTweenModel } = requireDist('utcp/utils/tween-sequence-model.js');
let root;
const previousEditor = global.Editor;
afterEach(() => {
  if (previousEditor === undefined) delete global.Editor; else global.Editor = previousEditor;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});
function descriptor() {
  return { version: 1, id: 'Boundary', target: { id: 'node-id', type: 'cc.Node' }, steps: [{ kind: 'to', duration: 0.5, easing: 'quadOut', properties: { position: { x: 10, y: 20, z: 0 } } }, { kind: 'delay', duration: 0.25 }], lifecycle: { start: 'manual', stop: 'on-disable', repeat: 2 } };
}
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tween-static-'));
  fs.mkdirSync(path.join(root, 'assets'));
  const rows = new Map();
  let mutations = 0;
  let target = { uuid: { value: 'node-id' } };
  global.Editor = { Project: { path: root }, Message: { request: async (service, method, ...args) => {
    if (service === 'asset-db' && method === 'query-asset-info') return rows.get(args[0]) || null;
    if (service === 'scene' && method === 'query-node') return target;
    if (service === 'asset-db' && method === 'create-asset') {
      mutations++;
      assert.deepEqual(args[2], { overwrite: false, rename: false });
      const file = path.join(root, args[0].slice('db://'.length));
      fs.writeFileSync(file, args[1], { flag: 'wx' });
      const row = { uuid: `script-${mutations}`, file, url: args[0] };
      rows.set(args[0], row);
      return row;
    }
    throw new Error(`Unexpected dispatch ${service}:${method}`);
  } } };
  return { rows, mutations: () => mutations, setTarget: value => { target = value; } };
}
it('refuses all existing project sources, sidecars and native/traversal paths before mutation', async () => {
  const f = fixture();
  const tools = new TweenSequenceTools();
  const args = { filePath: 'assets/Owned.ts', sequence: descriptor(), write: true };
  fs.writeFileSync(path.join(root, args.filePath), 'unrelated source');
  await assert.rejects(tools.tweenSequenceCreate(args), error => error.code === 'TWEEN_SOURCE_CONFLICT');
  assert.equal(fs.readFileSync(path.join(root, args.filePath), 'utf8'), 'unrelated source');
  fs.writeFileSync(path.join(root, 'assets/Sidecar.ts.meta'), 'owned metadata');
  await assert.rejects(tools.tweenSequenceCreate({ ...args, filePath: 'assets/Sidecar.ts' }), error => error.code === 'TWEEN_SOURCE_CONFLICT');
  for (const filePath of ['../Outside.ts', 'assets/../Outside.ts', 'db://assets/Native.tween', 'assets/Native.tween']) await assert.rejects(tools.tweenSequenceCreate({ ...args, filePath }), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(f.mutations(), 0);
});
it('requires explicit write approval and rejects invalid timing/easing/step bounds without creating files', async () => {
  const f = fixture();
  const tools = new TweenSequenceTools();
  const args = { filePath: 'assets/Bad.ts', sequence: descriptor() };
  await assert.rejects(tools.tweenSequenceCreate(args), error => error.code === 'WRITE_CONTRACT_REQUIRED');
  const cases = [
    [value => { value.steps[0].easing = "linear'); evil()"; }, 'UNSUPPORTED_EASING'],
    [value => { value.steps[0].duration = 0; }, 'INVALID_TIMING'],
    [value => { value.steps = Array.from({ length: 65 }, () => ({ kind: 'delay', duration: 1 })); }, 'INVALID_DESCRIPTOR'],
    [value => { value.steps = [{ kind: 'delay', duration: 600 }]; value.lifecycle.repeat = 7; }, 'INVALID_TIMING'],
    [value => { value.steps[0].properties.position.x = Infinity; }, 'INVALID_DESCRIPTOR'],
  ];
  for (const [mutate, code] of cases) {
    const sequence = descriptor(); mutate(sequence);
    const result = await tools.tweenSequenceValidate({ sequence });
    assert.equal(result.static.valid, false);
    assert.ok(result.static.diagnostics.some(issue => issue.code === code));
    await assert.rejects(tools.tweenSequenceCreate({ ...args, sequence, write: true }), error => error.code === 'INVALID_ARGUMENT');
  }
  assert.equal(f.mutations(), 0);
  assert.equal(fs.existsSync(path.join(root, 'assets/Bad.ts')), false);
});
it('reports missing/ambiguous targets and unavailable runtime separately from static source validity', async () => {
  const f = fixture();
  const tools = new TweenSequenceTools();
  f.setTarget(null);
  const missing = await tools.tweenSequenceValidate({ sequence: descriptor() });
  assert.equal(missing.static.valid, false);
  assert.equal(missing.static.diagnostics[0].code, 'MISSING_TARGET');
  await assert.rejects(tools.tweenSequenceCreate({ filePath: 'assets/Missing.ts', sequence: descriptor(), write: true }), error => error.code === 'MISSING_TARGET');
  f.setTarget({ uuid: 'different-node' });
  const ambiguous = await tools.tweenSequenceValidate({ sequence: descriptor() });
  assert.equal(ambiguous.static.diagnostics[0].code, 'TARGET_IDENTITY_MISMATCH');
  f.setTarget({ uuid: { value: 'node-id' } });
  const runtime = await tools.tweenSequenceValidate({ sequence: descriptor(), runtime: true });
  assert.equal(runtime.static.valid, true);
  assert.equal(runtime.static.compilation, 'not-run');
  assert.equal(runtime.valid, false);
  assert.equal(runtime.runtime.code, 'RUNTIME_UNAVAILABLE');
  assert.equal(f.mutations(), 0);
});
it('does not execute or trust modified source after authoritative create and read-back', async () => {
  fixture();
  const tools = new TweenSequenceTools();
  const filePath = 'assets/Boundary.ts';
  const created = await tools.tweenSequenceCreate({ filePath, sequence: descriptor(), write: true });
  const inspected = await tools.tweenSequenceInspect({ filePath });
  assert.deepEqual(inspected.sequence, descriptor());
  assert.equal(inspected.source.sha256, created.source.sha256);
  assert.equal(inspected.durationSeconds, 1.5);
  const file = path.join(root, filePath);
  fs.appendFileSync(file, '\nglobalThis.__tweenExecuted = true;\n');
  const modified = await tools.tweenSequenceValidate({ filePath });
  assert.equal(modified.static.valid, false);
  assert.equal(modified.static.diagnostics[0].code, 'SOURCE_MISMATCH');
  assert.equal(global.__tweenExecuted, undefined);
});
it('fails closed on Asset DB query/read-back errors, missing source and oversize source', async () => {
  const f = fixture();
  const tools = new TweenSequenceTools();
  await assert.rejects(tools.tweenSequenceInspect({ filePath: 'assets/Missing.ts' }), error => error.code === 'TARGET_NOT_FOUND');
  const original = global.Editor.Message.request;
  global.Editor.Message.request = async (service, message, ...args) => { if (message === 'query-asset-info') throw new Error('unavailable'); return original(service, message, ...args); };
  await assert.rejects(tools.tweenSequenceCreate({ filePath: 'assets/Query.ts', sequence: descriptor(), write: true }), error => error.code === 'ASSET_QUERY_FAILED');
  assert.equal(f.mutations(), 0);
  global.Editor.Message.request = original;
  await tools.tweenSequenceCreate({ filePath: 'assets/Large.ts', sequence: descriptor(), write: true });
  fs.writeFileSync(path.join(root, 'assets/Large.ts'), 'x'.repeat(65537));
  await assert.rejects(tools.tweenSequenceInspect({ filePath: 'assets/Large.ts' }), error => error.code === 'PAYLOAD_TOO_LARGE');
  global.Editor.Message.request = async (service, message, ...args) => {
    const result = await original(service, message, ...args);
    if (message === 'create-asset') fs.appendFileSync(result.file, '// changed during creation\n');
    return result;
  };
  await assert.rejects(tools.tweenSequenceCreate({ filePath: 'assets/Changed.ts', sequence: descriptor(), write: true }), error => error.code === 'TWEEN_SOURCE_READBACK_MISMATCH');
});
it('canonical generation is independent of caller object key order', () => {
  const sequence = descriptor();
  const reordered = { lifecycle: { repeat: 2, stop: 'on-disable', start: 'manual' }, steps: [{ properties: { position: { z: 0, y: 20, x: 10 } }, easing: 'quadOut', duration: 0.5, kind: 'to' }, { duration: 0.25, kind: 'delay' }], target: { type: 'cc.Node', id: 'node-id' }, id: 'Boundary', version: 1 };
  assert.equal(generateTweenCode(requireTweenModel(reordered)), generateTweenCode(requireTweenModel(sequence)));
});
it('separates unsupported source and malformed representation diagnostics without evaluating either', async () => {
  const f = fixture();
  const tools = new TweenSequenceTools();
  const filePath = 'assets/Unsupported.ts';
  const file = path.join(root, filePath);
  f.rows.set(`db://${filePath}`, { uuid: 'existing-script', url: `db://${filePath}`, file });
  fs.writeFileSync(file, 'throw new Error("must never execute");');
  const unsupported = await tools.tweenSequenceInspect({ filePath });
  assert.equal(unsupported.inspectable, false);
  assert.equal(unsupported.diagnostics[0].code, 'UNSUPPORTED_REPRESENTATION');
  fs.writeFileSync(file, '// ccp3x-tween-v1:{broken}\n');
  const malformed = await tools.tweenSequenceValidate({ filePath });
  assert.equal(malformed.static.valid, false);
  assert.equal(malformed.static.diagnostics[0].code, 'PARSE_ERROR');
  await assert.rejects(tools.tweenSequenceInspect({ filePath, sequence: descriptor() }), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(f.mutations(), 0);
});
it('refuses Asset DB-only conflicts and creation races instead of renaming or claiming success', async () => {
  const f = fixture();
  const tools = new TweenSequenceTools();
  const args = { filePath: 'assets/Conflict.ts', sequence: descriptor(), write: true };
  f.rows.set('db://assets/Conflict.ts', { uuid: 'owned', url: 'db://assets/Conflict.ts', file: path.join(root, args.filePath) });
  await assert.rejects(tools.tweenSequenceCreate(args), error => error.code === 'TWEEN_SOURCE_CONFLICT');
  assert.equal(f.mutations(), 0);
  const original = global.Editor.Message.request;
  global.Editor.Message.request = async (service, message, ...values) => {
    if (message === 'create-asset') { fs.writeFileSync(path.join(root, values[0].slice('db://'.length)), 'concurrent owner', { flag: 'wx' }); throw new Error('conflict'); }
    return original(service, message, ...values);
  };
  await assert.rejects(tools.tweenSequenceCreate({ ...args, filePath: 'assets/Race.ts' }), error => error.code === 'TWEEN_SOURCE_CONFLICT');
  assert.equal(fs.readFileSync(path.join(root, 'assets/Race.ts'), 'utf8'), 'concurrent owner');
  assert.equal(f.mutations(), 0);
});
