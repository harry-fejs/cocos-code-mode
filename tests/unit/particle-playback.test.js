'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { P4ContractTools } = requireDist('utcp/tools/p4-contract-tools.js');

afterEach(() => { delete global.Editor; });

describe('particlePlayback', () => {
  it('rejects an unverified session without dispatching to the edit renderer', async () => {
    let dispatches = 0;
    global.Editor = { Message: { request: async () => { dispatches++; throw Error('Edit renderer must not be used'); } } };
    const source = requireDist('utcp/tools/runtime-session-tools.js');
    const original = source.RuntimeSessionTools.prototype.runtimeSessionLifecycle;
    source.RuntimeSessionTools.prototype.runtimeSessionLifecycle = async () => ({ success: true, operation: 'inspect', ready: false });
    try {
      await assert.rejects(new P4ContractTools().particlePlayback({ sessionId: 'runtime-1', operation: 'play', nodeReference: { id: 'particle' } }), { code: 'RUNTIME_NOT_READY' });
      assert.equal(dispatches, 0);
    } finally { source.RuntimeSessionTools.prototype.runtimeSessionLifecycle = original; }
  });

  it('rejects unsupported operations before runtime dispatch', async () => {
    const tools = new P4ContractTools();
    await assert.rejects(
      tools.particlePlayback({ sessionId: 'runtime-1', operation: 'seek', nodeReference: { id: 'particle' } }),
      (error) => error.code === 'INVALID_ARGUMENT' && error.status === 400,
    );
  });
});
