'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');

const { FileTools } = requireDist('utcp/tools/file-tools.js');
const { PreferenceTools } = requireDist('utcp/tools/preference-tools.js');

function restoreEditor(previous) {
  if (previous === undefined) delete global.Editor;
  else global.Editor = previous;
}

describe('final asset/import authoring wave', () => {
  it('returns a bounded project-file snippet and rejects paths outside the project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-snippet-'));
    const previous = global.Editor;
    global.Editor = { Project: { path: root } };
    fs.writeFileSync(path.join(root, 'script.ts'), 'one\ntwo\nthree\nfour\nfive\n');
    try {
      const result = await new FileTools().projectFileSnippet({ filePath: 'script.ts', line: 3, radius: 1 });
      assert.deepEqual(result, { snippet: 'two\nthree\nfour', startLine: 2, endLine: 4 });
      await assert.rejects(() => new FileTools().projectFileSnippet({ filePath: '../outside.ts', line: 1 }), (error) => error.code === 'INVALID_ARGUMENT');
    } finally {
      restoreEditor(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('atomically writes and replaces bounded project files with read-back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-file-write-'));
    const previous = global.Editor;
    global.Editor = { Project: { path: root }, Message: { request: async () => true } };
    try {
      const tools = new FileTools();
      assert.deepEqual(await tools.projectWriteFile({ filePath: 'src/a.ts', content: 'alpha\nbeta\n' }), { success: true, bytesWritten: 11 });
      assert.deepEqual(await tools.projectReplaceInFile({ filePath: 'src/a.ts', search: 'beta', replace: 'gamma' }), { success: true, replacements: 1 });
      assert.deepEqual(await tools.projectReadFile({ filePath: 'src/a.ts' }), { content: 'alpha\ngamma\n', bytes: 12 });
      assert.deepEqual(await tools.projectSearchFiles({ pattern: '*.ts', directory: 'src' }), { files: ['src/a.ts'], total: 1, truncated: false });
      await assert.rejects(() => tools.projectWriteFile({ filePath: '../outside.ts', content: 'blocked' }), (error) => error.code === 'INVALID_ARGUMENT');
    } finally {
      restoreEditor(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps CCP preferences scoped and reads/writes arbitrary package preferences through preferences IPC', async () => {
    const previous = global.Editor;
    const values = new Map();
    global.Editor = {
      Profile: {
        async getConfig(pkg, key) { return values.get(`${pkg}:${key}`); },
        async setConfig(pkg, key, value) { values.set(`${pkg}:${key}`, value); },
      },
      Message: { request: async (service, method, pkg, key, value) => {
        assert.equal(service, 'preferences');
        assert.ok(['queryConfig', 'setConfig'].includes(method));
        const id = `${pkg}:${key}`;
        if (method === 'setConfig') { values.set(id, value); return true; }
        return values.get(id);
      } },
    };
    try {
      const tools = new PreferenceTools();
      assert.deepEqual(await tools.getEditorPreference({ key: 'toolProfile' }), { key: 'toolProfile', value: null });
      assert.deepEqual(await tools.setEditorPreference({ key: 'toolProfile', value: 'full' }), { success: true, key: 'toolProfile', value: 'full' });
      assert.deepEqual(await tools.queryPreferencesConfig({ packageName: 'pkg.third-party', key: 'enabled/path' }), { value: null });
      assert.deepEqual(await tools.setPreferencesConfig({ packageName: 'pkg.third-party', key: 'enabled/path', value: true }), { updated: true, value: true });
      await assert.rejects(() => tools.queryPreferencesConfig({ packageName: '../outside', key: 'x' }), /bounded preference identifiers/);
      assert.ok('all' in await tools.getEditorPreference({}));
    } finally {
      restoreEditor(previous);
    }
  });
});
