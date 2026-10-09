'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const template = fs.readFileSync(path.join(root, 'static/template/configuration/index.html'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'source/panels/configuration/index.ts'), 'utf8');
const loggingControl = fs.readFileSync(path.join(root, 'source/panels/configuration/logging-control.ts'), 'utf8');
describe('configuration guidance', () => {
  it('identifies the MCP server as CCP and exposes an agent instruction', () => {
    assert.match(template, /CCP/);
    assert.match(template, /id="agent-instruction"/);
    assert.match(template, /MCP configuration/i);
    assert.match(panel, /['"]ccp['"]/);
    assert.doesNotMatch(panel, /['"](?:cc-pilot|cocos-pilot|cc-bridge)['"]/);
    assert.doesNotMatch(panel, /['"]code-mode['"]/);
  });
});

it('exposes verbose logging policy controls and always-visible warning guidance', () => {
  assert.match(template, /id="verbose-policy-controls"/);
  assert.match(template, /id="verbose-tier"/);
  for (const group of ['protocol', 'read', 'behavior', 'lifecycle']) {
    assert.match(template, new RegExp(`id="verbose-group-${group}"`));
  }
  assert.match(template, /Warnings and errors are always visible/);
  assert.match(template, /without restarting the server/);
  assert.match(loggingControl, /Log file: available\./);
  assert.doesNotMatch(loggingControl, /boundedText\(next\.logFile/);
});

it('publishes the explicit occupied-port recovery route', () => {
  const pkg = require('../../package.json');
  assert.deepEqual(pkg.contributions.messages['recover-server-port'], { methods: ['recoverServerPort'] });
});
