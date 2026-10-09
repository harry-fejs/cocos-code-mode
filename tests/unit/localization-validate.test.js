'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist, readSource } = require('../helpers/require-dist');

const { ExpansionTools } = requireDist('utcp/tools/expansion-tools.js');
const { ToolRegistry } = requireDist('utcp/decorators.js');

afterEach(() => { delete global.Editor; });

function setRequest(request) {
  global.Editor = { Message: { request } };
}

function localizationTool() {
  return ToolRegistry.getTools().find(({ tool }) => tool.name === 'localizationValidate').tool;
}

describe('localizationValidate', () => {
  it('declares an exact bounded schema and uses only the fixed scene package seam', () => {
    const tool = localizationTool();
    assert.deepEqual(tool.inputs, {
      type: 'object',
      additionalProperties: false,
      properties: {
        keys: {
          type: 'array',
          minItems: 1,
          maxItems: 256,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
      required: ['keys'],
    });
    assert.deepEqual(tool.outputs, {
      type: 'object',
      additionalProperties: false,
      properties: {
        supported: { type: 'boolean' },
        language: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
        checkedKeys: { type: 'integer', minimum: 0, maximum: 256 },
        missingKeys: {
          type: 'array',
          maxItems: 256,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 256 },
        },
        error: { type: 'string', minLength: 1, maxLength: 512 },
      },
      required: ['supported', 'language', 'checkedKeys', 'missingKeys'],
      allOf: [{
        if: { properties: { supported: { const: false } }, required: ['supported'] },
        then: { required: ['error'] },
      }],
    });

    const source = readSource('utcp/tools/expansion-tools.ts');
    const start = source.indexOf("'localizationValidate'");
    const end = source.indexOf("'buildPresetValidate'", start);
    const slice = source.slice(start, end);
    assert.match(slice, /method: 'validateLocalization'/);
    assert.doesNotMatch(slice, /executeJavascript|switchLanguage|restart/);
  });

  it('validates bounded unique keys, calls the fixed method, and normalizes returned keys', async () => {
    const calls = [];
    setRequest(async (...args) => {
      calls.push(args);
      return {
        supported: true,
        language: 'en',
        checkedKeys: 3,
        missingKeys: ['missing-b', 'missing-a', 'missing-a'],
        ignored: 'raw response field must not pass through',
      };
    });

    const result = await new ExpansionTools().localizationValidate({ keys: ['present', 'missing-a', 'missing-b'] });
    assert.deepEqual(calls, [[
      'scene',
      'execute-scene-script',
      { name: 'ccp3x', method: 'validateLocalization', args: [['present', 'missing-a', 'missing-b']] },
    ]]);
    assert.deepEqual(result, {
      supported: true,
      language: 'en',
      checkedKeys: 3,
      missingKeys: ['missing-a', 'missing-b'],
    });
  });

  it('rejects invalid bounds, key lengths, duplicates, and extra method inputs before transport', async () => {
    let calls = 0;
    setRequest(async () => { calls += 1; return null; });
    const tools = new ExpansionTools();
    const invalid = [
      { keys: [] },
      { keys: Array.from({ length: 257 }, (_, index) => `key-${index}`) },
      { keys: ['duplicate', 'duplicate'] },
      { keys: [''] },
      { keys: ['x'.repeat(257)] },
      { keys: ['valid'], method: 'arbitrary' },
      { keys: [42] },
      null,
    ];
    for (const args of invalid) {
      await assert.rejects(
        tools.localizationValidate(args),
        (error) => error.code === 'INVALID_ARGUMENT' && error.status === 400,
      );
    }
    assert.equal(calls, 0);
  });

  it('normalizes unsupported scene/package responses to an explicit bounded result', async () => {
    setRequest(async () => ({
      supported: false,
      language: 'fr',
      checkedKeys: 99,
      missingKeys: ['secret'],
      extra: true,
    }));
    assert.deepEqual(await new ExpansionTools().localizationValidate({ keys: ['key'] }), {
      supported: false,
      language: null,
      checkedKeys: 0,
      missingKeys: [],
      error: 'Creator localization package is unavailable.',
    });

    setRequest(async () => ({ supported: false, error: `  ${'x'.repeat(600)}  ` }));
    const result = await new ExpansionTools().localizationValidate({ keys: ['key'] });
    assert.equal(result.supported, false);
    assert.equal(result.error.length, 512);
    assert.equal(result.error, 'x'.repeat(512));
  });

  it('reports transport and malformed response failures as typed 502 errors', async () => {
    setRequest(async () => { throw new Error('scene bridge offline'); });
    await assert.rejects(
      new ExpansionTools().localizationValidate({ keys: ['key'] }),
      (error) => error.code === 'LOCALIZATION_VALIDATION_FAILED' && error.status === 502,
    );

    setRequest(async () => ({ supported: true, language: null, checkedKeys: 2, missingKeys: [] }));
    await assert.rejects(
      new ExpansionTools().localizationValidate({ keys: ['key'] }),
      (error) => error.code === 'LOCALIZATION_INVALID_RESPONSE' && error.status === 502,
    );

    setRequest(async () => ({ supported: true, language: null, checkedKeys: 1, missingKeys: ['not-requested'] }));
    await assert.rejects(
      new ExpansionTools().localizationValidate({ keys: ['key'] }),
      (error) => error.code === 'LOCALIZATION_INVALID_RESPONSE' && error.status === 502,
    );
  });
});
