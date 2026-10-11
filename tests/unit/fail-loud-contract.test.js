'use strict';
// Durable regression guard for the docs §2 fail-loud audit + §7 typed-error contract.
// Runs in CI without an editor: source-contract asserts + pure predicate tests.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');

const { isMessageNotExposed } = requireDist('utcp/utils/editor-message-error.js');

function readSource(rel) {
  return fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
}

describe('fail-loud audit (docs §2) regressions', () => {
  it('isMessageNotExposed only matches the registry message-not-found form', () => {
    assert.equal(isMessageNotExposed(new Error('Message does not exist: scene - new-scene')), true);
    assert.equal(isMessageNotExposed(new Error('Message does not exist: scene - new-scene'), 'scene', 'new-scene'), true);
    assert.equal(isMessageNotExposed(new Error('Message does not exist: scene - new-scene'), 'scene', 'open-scene'), false);
    assert.equal(isMessageNotExposed(new Error('Config path "rendering" does not exist')), false);
    assert.equal(isMessageNotExposed(new Error('Asset db://assets/x.png does not exist')), false);
    assert.equal(isMessageNotExposed('Message does not exist: programming - query-sorted-plugins', 'programming', 'query-sorted-plugins'), true);
  });

  it('tool modules route unsupported-API checks through the anchored predicate', () => {
    for (const rel of [
      'source/utcp/tools/material-tools.ts',
      'source/utcp/tools/project-tools.ts',
      'source/utcp/tools/program-tools.ts',
      'source/utcp/tools/editor-tools.ts',
    ]) {
      const src = readSource(rel);
      assert.match(src, /isMessageNotExposed\(/, `${rel} must use the anchored predicate`);
      assert.doesNotMatch(src, /\/does not exist\/i/, `${rel} still uses the loose predicate`);
    }
  });

  it('no empty catch blocks remain in tool sources', () => {
    const dir = path.resolve(__dirname, '../../source/utcp/tools');
    const re = /catch\s*(\([^)]*\))?\s*\{\s*\}/;
    for (const fn of fs.readdirSync(dir)) {
      if (!fn.endsWith('.ts')) continue;
      assert.doesNotMatch(fs.readFileSync(path.join(dir, fn), 'utf8'), re, `${fn} has an empty catch`);
    }
  });

  it('write paths verify the engine outcome instead of faking success', () => {
    const setProps = readSource('source/utcp/tools/set-properties-tool.ts');
    assert.match(setProps, /ok === false\) throw new Error\(`set-property refused/);
    assert.match(setProps, /for \(let i = 0; i < value\.length; i\+\+\)/);
    assert.match(setProps, /componentIndex === -1/);
    assert.match(readSource('source/utcp/tools/scene-tools.ts'), /revert_prefab failed/);
    assert.match(readSource('source/utcp/tools/scene-tools.ts'), /move-array-element refused/);
    assert.match(readSource('source/utcp/tools/scene-tools.ts'), /INDEX_OUT_OF_RANGE/);
    assert.match(readSource('source/utcp/tools/animation-tools.ts'), /animation-operation returned an unexpected payload/);
  });

  it('image outputs verify magic bytes before returning (docs §1 canonical bug)', () => {
    const src = readSource('source/utcp/tools/screenshot-tools.ts');
    assert.match(src, /startsWith\('\/9j\/'\)/);
    assert.match(src, /iVBORw0KGgo/);
    assert.match(src, /isEmpty\(\)/);
  });

  it('nullish engine payloads throw instead of reading as empty-but-healthy', () => {
    assert.match(readSource('source/utcp/tools/scene-tools.ts'), /query-component-function-of-node returned no payload/);
    assert.match(readSource('source/utcp/tools/editor-tools.ts'), /returned no payload/);
    assert.match(readSource('source/utcp/tools/validation-tools.ts'), /diag\.ok === true/);
  });

  it('event reads refuse fabricated state (docs §2 false success)', () => {
    assert.match(readSource('source/utcp/tools/event-tools.ts'), /simulateButtonClick: unexpected response/);
    assert.match(readSource('source/utcp/tools/event-tools.ts'), /bindButtonClickEvent: unexpected response/);
  });

  it('component identity lookup carries the §1 fallback and fails loud', async () => {
    const scene = readSource('source/utcp/tools/scene-tools.ts');
    assert.match(scene, /c\?\.type \?\? c\?\.__type__ \?\? c\?\.cid/);
    const { ComponentTools } = requireDist('utcp/tools/component-tools.js');
    const previous = global.Editor;
    global.Editor = { Message: { request: async (service, message) => {
      if (service === 'scene' && message === 'query-node') return { __comps__: [{ value: { uuid: { value: 42 } } }, { type: 'cc.Sprite' }] };
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    try {
      const tools = new ComponentTools();
      await assert.rejects(() => tools.nodeComponentsGet({ reference: { id: 'node' } }), /lacks authoritative uuid/);
      await assert.rejects(() => tools.nodeComponentsGet({ reference: { id: 'node' }, componentType: 'cc.Sprite' }), /lacks authoritative uuid/);
    } finally {
      if (previous === undefined) delete global.Editor; else global.Editor = previous;
    }
  });

  it('inspectorGet names unknown fields; ui helpers no longer swallow text/sprite writes', () => {
    assert.match(readSource('source/utcp/tools/get-properties-tool.ts'), /fields not present on/);
    assert.match(readSource('source/utcp/tools/get-properties-tool.ts'), /hasOwnProperty/);
    assert.match(readSource('source/utcp/tools/consolidated-tools.ts'), /fields not present on/);
    assert.match(readSource('source/utcp/tools/consolidated-tools.ts'), /hasOwnProperty/);
    const ui = readSource('source/utcp/tools/ui-tools.ts');
    assert.doesNotMatch(ui, /catch \{\}/);
    assert.match(ui, /was not applied/);
    assert.match(ui, /PARTIAL_MUTATION/);
    assert.match(ui, /rollbackNode/);
    assert.match(ui, /remove-node/);
  });

  it('simulateKeyCombo rejects unknown and modifier-only combos instead of echoing success', () => {
    const src = readSource('source/utcp/tools/input-tools.ts');
    assert.match(src, /unknown modifier/);
    assert.match(src, /ends in a modifier/);
    assert.match(src, /INVALID_ARGUMENT/);
    assert.match(src, /ToolError/);
    assert.match(src, /input-tools.*tool-error|from '..\/tool-error'/);
  });
});
