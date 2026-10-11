'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { SceneTools } = requireDist('utcp/tools/scene-tools.js');

test('class-keyed method discovery returns actual component references without authorizing arbitrary methods', async () => {
  const previous = global.Editor;
  global.Editor = { Message: { request: async (_channel, message) => {
    if (message === 'query-node') return { __comps__: [
      { type: 'cc.Widget', value: { uuid: { value: 'widget-a' }, __type__: { value: 'cc.Widget' } } },
      { type: 'cc.Widget', value: { uuid: { value: 'widget-b' }, __type__: { value: 'cc.Widget' } } },
    ] };
    if (message === 'query-component-function-of-node') return { 'cc.Widget': ['updateAlignment', 'unscheduleAllCallbacks'] };
    throw new Error('Unexpected message ' + message);
  } } };
  try {
    const result = await new SceneTools().listComponentMethods({ reference: { id: 'node' } });
    assert.deepEqual(result.components.map(c => c.reference.id), ['widget-a', 'widget-b']);
    assert.deepEqual(result.components[0].permittedMethods, ['unscheduleAllCallbacks']);
    assert.deepEqual(result.components[0].deniedMethods, ['updateAlignment']);
  } finally { global.Editor = previous; }
});
