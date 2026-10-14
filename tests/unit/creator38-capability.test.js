'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { ExpansionTools } = requireDist('utcp/tools/expansion-tools.js');

afterEach(() => { delete global.Editor; });

describe('Creator3.8 editor/content gates', () => {
  it('refuses particle mutation on Creator3.7 before querying the scene', async () => {
    let calls = 0;
    global.Editor = { App: { version: '3.7.3' }, Message: { request: async () => { calls += 1; return null; } } };
    await assert.rejects(
      () => new ExpansionTools().particleConfigure({ reference: { id: 'node' }, properties: { rateOverTime: 20 } }),
      error => error.code === 'UNSUPPORTED_EDITOR_VERSION' && error.status === 422,
    );
    assert.equal(calls, 0);
  });
});
