'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requireDist } = require('../helpers/require-dist');
const { executeAudioPlayback } = requireDist('audio-playback.js');
const { AudioPlaybackTools } = requireDist('utcp/tools/audio-playback-tools.js');
const { RuntimeSessionTools } = requireDist('utcp/tools/runtime-session-tools.js');
const { ToolError } = requireDist('utcp/tool-error.js');

const originalInspect = RuntimeSessionTools.prototype.runtimeSessionLifecycle;
const originalEditor = global.Editor;
afterEach(() => {
  RuntimeSessionTools.prototype.runtimeSessionLifecycle = originalInspect;
  if (originalEditor === undefined) delete global.Editor;
  else global.Editor = originalEditor;
});

function fixture() {
  class AudioSource {
    static AudioState = { INIT: 0, PLAYING: 1, PAUSED: 2, STOPPED: 3, INTERRUPTED: 4 };
    static EventType = { STARTED: 'started', ENDED: 'ended' };
    constructor() {
      this.clip = { isValid: true };
      this._lastSetClip = this.clip;
      this._isLoaded = true;
      this._player = {};
      this.duration = 2;
      this.currentTime = 0;
      this.state = 0;
      this.calls = [];
    }
    get playing() { return this.state === 1; }
    play() { this.calls.push('play'); queueMicrotask(() => { this.state = 1; node.emit('started', this); }); }
    pause() { this.calls.push('pause'); queueMicrotask(() => { this.state = 2; }); }
    stop() { this.calls.push('stop'); queueMicrotask(() => { this.state = 3; this.currentTime = 0; }); }
  }
  const source = new AudioSource();
  const scene = { uuid: 'scene-1' };
  const node = Object.assign(new EventEmitter(), { uuid: 'node-1', parent: scene, getComponents: () => [source] });
  const cc = { GAME_VIEW: true, AudioSource, director: { getScene: () => scene } };
  const run = (operation, extra = {}) => executeAudioPlayback({ sessionId: 'session-1', targetId: scene.uuid,
    nodeUuid: node.uuid, operation, timeoutMs: 100, ...extra }, cc, async () => node);
  return { source, scene, node, cc, run };
}

function installTools(response, inspect = {}) {
  const calls = [];
  RuntimeSessionTools.prototype.runtimeSessionLifecycle = async () => ({ success: true, ready: true,
    session: { sessionId: 'session-1', targetKind: 'game-view', targetId: 'scene-1', status: 'attached' }, ...inspect });
  global.Editor = { Message: { request: async (...args) => { calls.push(args); return response; } } };
  return { tools: new AudioPlaybackTools(), calls, args: { sessionId: 'session-1', nodeReference: { id: 'node-1' } } };
}

describe('bounded AudioSource scene control', () => {
  it('confirms asynchronous start, pause, seek and stop with actual state', async () => {
    const { source, node, run } = fixture();
    const played = await run('play');
    assert.equal(played.success, true);
    assert.equal(played.started, true);
    assert.equal(played.state.playing, true);
    assert.equal(node.listenerCount('started'), 0);
    const paused = await run('pause');
    assert.equal(paused.state.playing, false);
    assert.equal(paused.state.playbackState, 'paused');
    assert.equal((await run('seek', { time: 1 })).state.currentTime, 1);
    const stopped = await run('stop');
    assert.equal(stopped.state.currentTime, 0);
    assert.equal(stopped.state.playbackState, 'stopped');
    assert.deepEqual(source.calls, ['play', 'pause', 'stop']);
  });

  it('recognizes very short playback ending before the next poll', async () => {
    const { source, node, run } = fixture();
    source.play = () => queueMicrotask(() => { node.emit('started', source); node.emit('ended', source); });
    const result = await run('play');
    assert.equal(result.success, true);
    assert.equal(result.started, true);
    assert.equal(result.ended, true);
    assert.equal(result.state.playing, false);
    assert.equal(node.listenerCount('ended'), 0);
  });

  it('does not confuse already-playing state or another source event with restart confirmation', async () => {
    const { source, node, run } = fixture();
    source.state = 1;
    source.play = () => node.emit('started', {});
    const result = await run('play');
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'AUDIO_START_TIMEOUT');
    assert.equal(result.error.state.playing, true);
    assert.equal(result.error.pendingMayComplete, true);
    assert.equal(node.listenerCount('started'), 0);
    assert.equal(node.listenerCount('ended'), 0);
    assert.equal((await run('stop')).error.code, 'AUDIO_CONTROL_UNCERTAIN');
    assert.equal((await run('observe')).state.playing, true);
  });

  it('rejects concurrent control while allowing nonmutating observation', async () => {
    const { source, node, run } = fixture();
    let announce;
    const entered = new Promise((resolve) => { announce = resolve; });
    source.play = () => announce();
    const pending = run('play');
    await entered;
    assert.equal((await run('pause')).error.code, 'AUDIO_CONTROL_BUSY');
    assert.equal((await run('observe')).state.playing, false);
    source.state = 1;
    node.emit('started', source);
    assert.equal((await pending).success, true);
    assert.equal((await run('stop')).success, true);
  });

  it('validates seek bounds before touching playback time and accepts endpoints', async () => {
    const { source, run } = fixture();
    for (const time of [-1, NaN, Infinity, 2.001]) {
      const result = await run('seek', { time });
      assert.equal(result.success, false);
      assert.equal(source.currentTime, 0);
    }
    assert.equal((await run('seek', { time: 2 })).state.currentTime, 2);
    assert.equal((await run('seek', { time: 0 })).state.currentTime, 0);
    assert.equal((await run('play', { time: 1 })).error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(source.calls, []);
  });

  it('rejects cached loading state, absent clips, missing APIs and ambiguous components without mutation', async () => {
    const { source, node, run } = fixture();
    source._isLoaded = false;
    assert.equal((await run('seek', { time: 1 })).error.code, 'AUDIO_NOT_READY');
    assert.equal(source.currentTime, 0);
    source._isLoaded = true;
    source.clip = null;
    assert.equal((await run('play')).error.code, 'AUDIO_CLIP_MISSING');
    source.clip = {};
    assert.equal((await run('play')).error.code, 'AUDIO_NOT_READY');
    source._lastSetClip = source.clip;
    source.play = undefined;
    assert.equal((await run('play')).error.code, 'AUDIO_API_UNAVAILABLE');
    node.getComponents = () => [source, source];
    assert.equal((await run('stop')).error.code, 'AUDIO_COMPONENT_INVALID');
    assert.deepEqual(source.calls, []);
  });

  it('rejects stopped or mismatched scenes and foreign nodes', async () => {
    const { source, node, cc, run } = fixture();
    cc.GAME_VIEW = false;
    assert.equal((await run('play')).error.code, 'RUNTIME_NOT_READY');
    cc.GAME_VIEW = true;
    assert.equal((await run('play', { targetId: 'other-scene' })).error.code, 'RUNTIME_TARGET_CHANGED');
    node.parent = { uuid: 'foreign-scene' };
    assert.equal((await run('play')).error.code, 'RUNTIME_TARGET_CHANGED');
    assert.deepEqual(source.calls, []);
  });

  it('observe never synthesizes absent playing state or mutates playback', async () => {
    const { source, run } = fixture();
    const observed = await run('observe');
    assert.equal(observed.state.activationRequirement, 'unknown');
    assert.equal(observed.state.currentTime, 0);
    assert.deepEqual(source.calls, []);
    Object.defineProperty(source, 'playing', { value: undefined });
    assert.equal((await run('observe')).error.code, 'AUDIO_STATE_UNAVAILABLE');
  });

  it('returns a structured error and removes listeners after a clip changes during start', async () => {
    const { source, node, run } = fixture();
    source.play = () => { source.clip = {}; };
    const result = await run('play');
    assert.equal(JSON.parse(JSON.stringify(result)).error.code, 'AUDIO_TARGET_CHANGED');
    assert.equal(node.listenerCount('started'), 0);
    assert.equal(node.listenerCount('ended'), 0);
  });

  it('does not report paused or stopped for a silent no-op on init/interrupted state', async () => {
    const paused = fixture();
    paused.source.state = 4;
    paused.source.pause = () => {};
    assert.equal((await paused.run('pause')).error.code, 'AUDIO_CONTROL_TIMEOUT');
    const stopped = fixture();
    stopped.source.stop = () => {};
    assert.equal((await stopped.run('stop')).error.code, 'AUDIO_CONTROL_TIMEOUT');
  });

  it('returns already paused/stopped state without issuing another engine command', async () => {
    const { source, run } = fixture();
    source.state = 2;
    assert.equal((await run('pause')).success, true);
    source.state = 3;
    assert.equal((await run('stop')).success, true);
    assert.deepEqual(source.calls, []);
  });

  it('does not confuse nearby unchanged time with completed seek', async () => {
    const { source, run } = fixture();
    source.state = 2;
    Object.defineProperty(source, 'currentTime', { get: () => 0, set: () => {}, configurable: true });
    const result = await run('seek', { time: 0.01 });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'AUDIO_CONTROL_TIMEOUT');
  });
});

describe('audio public runtime-session boundary', () => {
  it('rejects stopped/not-ready sessions before sending audio mutation', async () => {
    const context = installTools({}, { ready: false });
    await assert.rejects(context.tools.audioPlaybackControl({ ...context.args, operation: 'play' }), (e) => e.code === 'RUNTIME_NOT_READY');
    assert.deepEqual(context.calls, []);
    const stopped = installTools({}, { ready: false, session: { sessionId: 'session-1', targetKind: 'game-view', targetId: 'scene-1', status: 'stopped' } });
    await assert.rejects(stopped.tools.audioPlaybackObserve(stopped.args), (e) => e.code === 'RUNTIME_SESSION_STOPPED');
    assert.deepEqual(stopped.calls, []);
  });

  it('uses the Game View operation boundary instead of edit-renderer IPC', async () => {
    const context = installTools({ success: true });
    const expected = ['AUDIO_TRANSPORT_UNAVAILABLE', 'RUNTIME_CONTROL_UNAVAILABLE', 'UNSUPPORTED_RUNTIME_TRANSPORT', 'RUNTIME_NOT_READY'];
    await assert.rejects(context.tools.audioPlaybackControl({ ...context.args, operation: 'play' }), (e) => e instanceof ToolError && expected.includes(e.code));
    await assert.rejects(context.tools.audioPlaybackObserve(context.args), (e) => e instanceof ToolError && expected.includes(e.code));
    assert.deepEqual(context.calls, []);
  });

  it('rejects invalid timeout and operation before invoking scene IPC', async () => {
    const { tools, args, calls } = installTools({});
    await assert.rejects(tools.audioPlaybackControl({ ...args, operation: 'observe' }), (e) => e.code === 'INVALID_ARGUMENT');
    await assert.rejects(tools.audioPlaybackControl({ ...args, operation: 'play', timeoutMs: 5001 }), (e) => e.code === 'INVALID_ARGUMENT');
    await assert.rejects(tools.audioPlaybackControl({ ...args, operation: 'seek', time: Infinity }), (e) => e.code === 'INVALID_ARGUMENT');
    assert.deepEqual(calls, []);
  });
});
