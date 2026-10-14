'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist, readSource } = require('../helpers/require-dist');

const { ExpansionTools } = requireDist('utcp/tools/expansion-tools.js');
const { P4ContractTools } = requireDist('utcp/tools/p4-contract-tools.js');
const { PortfolioValidationTools } = requireDist('utcp/tools/portfolio-validation-tools.js');
const { AdvancedCapabilityTools } = requireDist('utcp/tools/advanced-capability-tools.js');

afterEach(() => { delete global.Editor; });

describe('Wave K editor configuration contracts', () => {
  it('registers the bounded configuration routes', () => {
    assert.match(readSource('utcp/tools/expansion-tools.ts'), /utcpTool\s*\(\s*'particleConfigure'/);
    assert.match(readSource('utcp/tools/p4-contract-tools.ts'), /utcpTool\s*\(\s*'physics2dConfigure'/);
    assert.match(readSource('utcp/tools/p4-contract-tools.ts'), /utcpTool\s*\(\s*'physics3dConfigure'/);
    assert.match(readSource('utcp/tools/material-tools.ts'), /utcpTool\s*\(\s*'renderConfigurationApply'/);
    assert.match(readSource('utcp/tools/advanced-capability-tools.ts'), /utcpTool\s*\(\s*'previewResolutionSet'/);
  });

  it('configures a serialized particle field and verifies scene read-back', async () => {
    const node = {
      uuid: 'particle-node',
      __comps__: [{ type: 'cc.ParticleSystem2D', value: {
        uuid: { value: 'particle-component' },
        rateOverTime: { value: 10, type: 'Float' },
      } }],
    };
    global.Editor = { App: { version: '3.8.8' }, Message: { request: async (service, message, payload) => {
      if (message === 'query-node') return node;
      if (message === 'set-property') { node.__comps__[0].value.rateOverTime = payload.dump; return true; }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${service}:${message}`);
    } } };
    const result = await new ExpansionTools().particleConfigure({ reference: { id: 'particle-node' }, properties: { rateOverTime: 20 } });
    assert.deepEqual(result.componentReference, { id: 'particle-component', type: 'cc.ParticleSystem2D' });
    assert.deepEqual(result.properties, { rateOverTime: 20 });
    assert.deepEqual(result.changed, ['rateOverTime']);
    assert.equal(result.verified, true);
  });

  it('fails closed for unavailable Creator 3.7 project settings writes', async () => {
    global.Editor = { Message: { request: async () => { throw new Error('Message does not exist: project - set-config'); } } };
    const tools = new P4ContractTools();
    await assert.rejects(() => tools.physics2dConfigure({ path: 'physics.collisionMatrix', value: {} }), error => error.code === 'UNSUPPORTED_EDITOR_API' && error.status === 422);
    await assert.rejects(() => tools.physics3dConfigure({ path: 'physics.gravity', value: { x: 0, y: -9.8, z: 0 } }), error => error.code === 'UNSUPPORTED_EDITOR_API' && error.status === 422);
  });

  it('keeps retarget metadata and preview IPC fail-closed without mutation', async () => {
    global.Editor = { App: { version: '3.8.8' }, Message: { request: async (service, message) => {
      if (service === 'asset-db' && message === 'query-asset-info') return { uuid: 'model', type: 'cc.FBX', url: 'db://assets/model.fbx', meta: { userData: {} } };
      throw new Error(`Message does not exist: ${service} - ${message}`);
    } } };
    await assert.rejects(() => new PortfolioValidationTools().animationRetargetValidate({ sourceReference: { id: 'model' }, targetReference: { id: 'model' } }), error => error.code === 'UNSUPPORTED_METADATA' && error.status === 422);
    await assert.rejects(() => new AdvancedCapabilityTools().previewResolutionSet({ width: 800, height: 600 }), error => error.code === 'UNSUPPORTED_PREVIEW_IPC' && error.status === 422);
  });
});
