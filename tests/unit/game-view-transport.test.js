'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { requireDist } = require('../helpers/require-dist');
const { inspectGameViewRuntime } = requireDist('utcp/utils/game-view-transport.js');

it('reads only the identified Game View renderer and rejects edit-renderer substitution', async () => {
  const originalLoad = Module._load;
  let gameView = true;
  let enabled = true;
  let rendererReads = 0;
  const host = { platform: 'gameView', ready: true, loaded: true, failed: false, webContentsId: 7 };
  const main = { isDestroyed: () => false, getURL: () => 'file:///C:/Creator/resources/app.asar/node_modules/@editor/creator/static/windows/main.html#project',
    executeJavaScript: async () => [{ ...host, enabled }] };
  const preview = { id: 7, isDestroyed: () => false, getType: () => 'webview',
    getURL: () => 'packages://scene/static/template/3d-webview.html?url=preload%5Cpreview%5Cpreload.js',
    executeJavaScript: async () => { rendererReads++; return { gameView, phase: 'play', paused: false, sceneUuid: 'runtime-scene', timeScale: 1, frameCount: 42 }; } };
  Module._load = function (name, parent, isMain) {
    if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [{ webContents: main }] }, webContents: { fromId: id => id === 7 ? preview : undefined } };
    return originalLoad.call(this, name, parent, isMain);
  };
  try {
    const state = await inspectGameViewRuntime();
    assert.equal(state.sceneUuid, 'runtime-scene');
    assert.equal(state.frameCount, 42);
    gameView = false;
    await assert.rejects(inspectGameViewRuntime(), { code: 'RUNTIME_NOT_READY' });
    enabled = false;
    const before = rendererReads;
    const stopped = await inspectGameViewRuntime();
    assert.equal(stopped.running, false);
    assert.equal(stopped.paused, null);
    assert.equal(stopped.sceneUuid, '');
    assert.equal(rendererReads, before);
  } finally { Module._load = originalLoad; }
});

it('rejects a renderer replaced during read-back', async () => {
  const originalLoad = Module._load;
  let reads = 0;
  const main = { isDestroyed: () => false, getURL: () => 'file:///Creator/node_modules/@editor/creator/static/windows/main.html',
    executeJavaScript: async () => [{ platform: 'gameView', enabled: true, ready: true, loaded: true, failed: false, webContentsId: ++reads === 1 ? 7 : 8 }] };
  const preview = { id: 7, isDestroyed: () => false, getType: () => 'webview', getURL: () => 'packages://scene?url=preload%5Cpreview%5Cpreload.js',
    executeJavaScript: async () => ({ gameView: true, phase: 'play', paused: false, sceneUuid: 'runtime', timeScale: 1, frameCount: 1 }) };
  Module._load = function (name, parent, isMain) {
    if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [{ webContents: main }] }, webContents: { fromId: () => preview } };
    return originalLoad.call(this, name, parent, isMain);
  };
  try { await assert.rejects(inspectGameViewRuntime(), { code: 'RUNTIME_TARGET_CHANGED' }); }
  finally { Module._load = originalLoad; }
});

it('reports an unselected unloaded host as stopped without reading a renderer', async () => {
  const originalLoad = Module._load;
  const host = { enabled: false, ready: false, loaded: false, failed: false, webContentsId: null };
  const main = { isDestroyed: () => false, getURL: () => 'file:///Creator/node_modules/@editor/creator/static/windows/main.html', executeJavaScript: async () => [host] };
  Module._load = function (name, parent, isMain) {
    if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [{ webContents: main }] }, webContents: { fromId: () => { throw Error('Unloaded host must not read renderer'); } } };
    return originalLoad.call(this, name, parent, isMain);
  };
  try {
    const state = await inspectGameViewRuntime();
    assert.equal(state.running, false);
    assert.equal(state.platform, '');
    assert.equal(state.sceneUuid, '');
    host.enabled = true;
    await assert.rejects(inspectGameViewRuntime(), { code: 'UNSUPPORTED_RUNTIME_TRANSPORT' });
  } finally { Module._load = originalLoad; }
});
