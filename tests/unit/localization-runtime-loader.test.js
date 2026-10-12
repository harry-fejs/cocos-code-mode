'use strict';
const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { loadLocalizationRuntime } = requireDist('localization-runtime.js');
afterEach(() => { delete global.Editor; delete global.System; });
it('loads the exact mounted official runtime through Creator SystemJS, not Node require', async () => {
  let imported;
  const runtime = { currentLanguage: 'en-US', exists: key => key === 'present', direction: () => 'ltr' };
  global.Editor = { Message: { request: async () => ({ uuid: 'official', url: 'db://localization-editor/l10n.ts', file: 'C:/project/extensions/localization-editor/static/assets/l10n.ts' }) } };
  global.System = { import: async url => { imported = url; return { l10n: runtime }; } };
  const result = await loadLocalizationRuntime();
  assert.equal(result.exists('present'), true);
  assert.equal(result.exists('missing'), false);
  assert.match(imported, /^file:\/\/\/C:\/project\/extensions\/localization-editor\/static\/assets\/l10n\.ts$/);
});
it('refuses foreign asset identity before importing runtime code', async () => {
  let imported = false;
  global.Editor = { Message: { request: async () => ({ uuid: 'other', url: 'db://assets/unrelated.ts', file: 'C:/project/assets/unrelated.ts' }) } };
  global.System = { import: async () => { imported = true; } };
  await assert.rejects(loadLocalizationRuntime(), /identity is unavailable/);
  assert.equal(imported, false);
});
