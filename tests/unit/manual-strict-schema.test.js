'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readSource, requireDist } = require('../helpers/require-dist');

// Plan 1-wip-260831__tbd-ccp3x-manual-schema-compatibility
// Code Mode validates each tool with a strict schema: any extra per-tool key
// (notably `annotations`) fails registration for EVERY tool, not just itself.
// Profile metadata must stay in ToolProfileRegistry, never in the UTCP manual.
// This test is the CI-runnable guard so the invariant holds even when the live
// editor is not running.

describe('manual strict schema — no annotations in UTCP tools', () => {
  it('source does not inject toolDef.annotations', () => {
    const src = readSource('utcp/utcp-server.ts');
    assert.equal(/toolDef\.annotations/.test(src), false, 'source must not assign toolDef.annotations');
    assert.equal(/toolDef\[.annotations/.test(src), false, 'source must not assign toolDef[annotations]');
    assert.match(src, /Profile annotations remain in ToolProfileRegistry/, 'guard comment must be present');
    assert.match(src, /Do NOT add fields here/, 'strict-manual comment must be present');
  });

  it('compiled dist does not inject annotations', () => {
    const distPath = path.resolve(__dirname, '..', '..', 'dist', 'utcp', 'utcp-server.js');
    if (!fs.existsSync(distPath)) {
      // Build not run yet in this environment — source check above is the gate.
      return;
    }
    const dist = fs.readFileSync(distPath, 'utf8');
    assert.equal(/\.annotations/.test(dist) && /toolDef/.test(dist) && /annotations/.test(dist.slice(dist.indexOf('toolDef'))), false);
    // More precise: the dist must not contain an assignment to toolDef.annotations at all.
    assert.equal(/toolDef\.annotations\s*=/.test(dist), false, 'dist must not assign toolDef.annotations');
  });

  it('ToolProfileRegistry keeps annotations out of the Tool object', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'source', 'utcp', 'decorators.ts'), 'utf8');
    assert.match(src, /registerToolProfile/, 'decorators must register profile metadata separately');
    // The Tool object pushed to ToolRegistry must have exactly the UTCP SDK fields:
    // name, description, inputs, outputs, tags, tool_call_template — no annotations/profile.
    assert.equal(/tool:\s*\{[^}]*annotations/.test(src), false, 'Tool object literal must not include annotations');
  });

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

  it('restart lifecycle closes the prior socket before publishing a fresh manager', () => {
    const mainSrc = readSource('main.ts');
    assert.match(mainSrc, /await stopPublishedServer\(previousServer\)/, 'restartServer must await prior server shutdown');
    assert.match(mainSrc, /const server = new UtcpServerManager\(\)/, 'published startup must create a fresh manager');
    assert.match(mainSrc, /utcpServer = server/, 'published startup must publish the fresh manager');
    assert.match(mainSrc, /await config\.updatePort\(actualPort, server\.instanceId\)/, 'published startup must update config after start');
    const serverSrc = readSource('utcp/utcp-server.ts');
    assert.match(serverSrc, /server\.close\(/, 'stop() must call server.close with callback');
    assert.match(serverSrc, /this\.port = 0/, 'stop() must clear port');
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
    const labels = (pkg.contributions?.menu || []).map((m) => String(m.label));
    assert.equal(labels.some((l) => /reload/i.test(l)), false, 'menu must not contain Reload Extension');
  });

});
