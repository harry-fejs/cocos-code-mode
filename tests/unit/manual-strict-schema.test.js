'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');

describe('manual output schema', () => {

  it('outputs are slimmed (strict slimOutputsSchema path)', () => {
    const { slimOutputsSchema } = requireDist('utcp/utils/schema-slimmer.js');
    // Realistic outputs shape: nested property detail must be stripped, only
    // top-level type (+ const/enum) retained. This is the slim path the server
    // applies via `toolDef.outputs = slimOutputsSchema(toolDef.outputs)`.
    const slimmed = slimOutputsSchema({
      type: 'object',
      properties: {
        reference: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], description: 'drop' },
        name: { type: 'string', description: 'drop' },
        children: { type: 'array', items: { type: 'object' }, description: 'drop' },
      },
      required: ['reference', 'name'],
    });
    assert.deepEqual(Object.keys(slimmed.properties).sort(), ['children', 'name', 'reference']);
    assert.deepEqual(slimmed.properties.reference, { type: 'object' });
    assert.deepEqual(slimmed.properties.name, { type: 'string' });
    assert.equal(slimmed.properties.reference.description, undefined, 'nested description must be stripped');
  });
});
