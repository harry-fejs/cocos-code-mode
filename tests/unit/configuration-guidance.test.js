'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const template = fs.readFileSync(path.join(root, 'static/template/configuration/index.html'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'source/panels/configuration/index.ts'), 'utf8');

describe('configuration guidance', () => {
  it('identifies the MCP server as CCP and exposes an agent instruction', () => {
    assert.match(template, /CCP MCP Integration/);
    assert.match(template, /id="agent-instruction-code"/);
    assert.match(template, /discover.*act/i);
    assert.match(panel, /"ccp":/);
    assert.doesNotMatch(panel, /"code-mode":/);
  });
});
