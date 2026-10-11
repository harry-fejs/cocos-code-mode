'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const vm = require('node:vm');
const { requireDist } = require('../helpers/require-dist');
const { inspectGameViewRuntime, setGameViewTimeScale } = requireDist('utcp/utils/game-view-transport.js');

it('mutates only the verified Game View scheduler and refuses inconsistent or unsupported targets', async () => {
  const originalLoad = Module._load;
  let scale = 1;
  let paused = false;
  let writes = 0;
  let scene = { uuid: 'runtime-scene' };
  const scheduler = { getTimeScale: () => scale, setTimeScale: value => { writes++; scale = value; } };
  const cc = { GAME_VIEW: true, game: { isPaused: () => paused }, director: { totalFrames: 9, getScene: () => scene, getScheduler: () => scheduler } };
  const context = vm.createContext({ cc, cce: { PreviewPlay: { _state: 'play' } } });
  const main = { isDestroyed: () => false, getURL: () => 'file:///Creator/node_modules/@editor/creator/static/windows/main.html',
    executeJavaScript: async () => [{ platform: 'gameView', enabled: true, ready: true, loaded: true, failed: false, webContentsId: 7 }] };
  const preview = { id: 7, isDestroyed: () => false, getType: () => 'webview', getURL: () => 'packages://scene?url=preload%5Cpreview%5Cpreload.js',
    executeJavaScript: async code => vm.runInContext(code, context) };
  Module._load = function (name, parent, isMain) {
    if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [{ webContents: main }] }, webContents: { fromId: () => preview } };
    return originalLoad.call(this, name, parent, isMain);
  };
  try {
    assert.equal((await setGameViewTimeScale(0.5)).timeScale, 0.5);
    assert.equal(writes, 1);
    paused = true;
    await assert.rejects(inspectGameViewRuntime(), { code: 'RUNTIME_NOT_READY' });
    await assert.rejects(setGameViewTimeScale(2), { code: 'RUNTIME_NOT_READY' });
    assert.equal(writes, 1);
    paused = false;
    scheduler.setTimeScale = undefined;
    await assert.rejects(setGameViewTimeScale(2), { code: 'UNSUPPORTED_RUNTIME_TRANSPORT' });
    assert.equal(scale, 0.5);
    scheduler.setTimeScale = value => { scale = value; scene = { uuid: 'replacement' }; };
    await assert.rejects(setGameViewTimeScale(2), { code: 'RUNTIME_TARGET_CHANGED' });
  } finally { Module._load = originalLoad; }
});
