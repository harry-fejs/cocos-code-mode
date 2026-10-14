'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { requireDist } = require('../helpers/require-dist');
const { createComponentOperationSource } = requireDist('utcp/utils/game-view-components.js');

it('executes the complete trusted particle bundle and refuses ambiguous components without mutation', async () => {
  class Particle {}
  const scene = { uuid: 'scene', children: [] };
  let commands = 0;
  const node = { uuid: 'particle', children: [], parent: scene, getComponents: () => components };
  const component = { uuid: 'component', node, isPlaying: false, play() { commands++; this.isPlaying = true; }, stop() { commands++; this.isPlaying = false; }, clear() { commands++; }, getParticleCount() { return 0; } };
  let components = [component];
  scene.children = [node];
  const cc = { GAME_VIEW: true, ENGINE_VERSION: '3.7.3', director: { getScene: () => scene }, js: { getClassByName: name => name === 'cc.ParticleSystem' ? Particle : undefined }, isValid: () => true };
  const context = vm.createContext({ cc, setTimeout, clearTimeout, setInterval, clearInterval });
  const request = { sessionId: 'session', nodeReference: { id: 'particle' }, kind: 'particle', operation: 'play', timeoutMs: 1000 };
  const played = await vm.runInContext(createComponentOperationSource(request), context);
  assert.equal(played.state.playing, true);
  assert.equal(commands, 1);
  const inspected = await vm.runInContext(createComponentOperationSource({ ...request, operation: 'inspect' }), context);
  assert.equal(inspected.state.playing, true);
  assert.equal(commands, 1, 'inspection must not dispatch a playback method');
  components = [component, { ...component, uuid: 'second' }];
  const refused = await vm.runInContext(createComponentOperationSource(request), context);
  assert.equal(refused.code, 'AMBIGUOUS_RUNTIME_COMPONENT');
  assert.equal(refused.mutationDispatched, false);
  assert.equal(commands, 1);
});

it('rejects graph variable type mismatch before setting the engine value', async () => {
  class Controller {}
  const scene = { uuid: 'scene', children: [] };
  let value = 1;
  let writes = 0;
  const node = { uuid: 'graph-node', children: [], parent: scene, getComponents: () => [component] };
  const component = { uuid: 'controller', node, graph: { uuid: 'graph' }, layerCount: 0, getVariables: () => [['speed', { type: 0 }]], getValue: () => value, setValue: (_name, next) => { writes++; value = next; }, getCurrentStateStatus: () => null, getCurrentClipStatuses: () => [], getCurrentTransition: () => null };
  scene.children = [node];
  const cc = { GAME_VIEW: true, ENGINE_VERSION: '3.7.3', director: { getScene: () => scene }, js: { getClassByName: () => Controller }, isValid: () => true };
  const context = vm.createContext({ cc, setTimeout, clearTimeout, setInterval, clearInterval });
  const request = { sessionId: 'session', nodeReference: { id: 'graph-node' }, componentId: 'controller', kind: 'graph', operation: 'setVariable', variable: { name: 'speed', type: 'boolean', value: true }, timeoutMs: 1000 };
  const refused = await vm.runInContext(createComponentOperationSource(request), context);
  assert.equal(refused.code, 'UNSUPPORTED_GRAPH_VARIABLE');
  assert.equal(writes, 0);
  request.variable = { name: 'speed', type: 'float', value: 2 };
  const applied = await vm.runInContext(createComponentOperationSource(request), context);
  assert.equal(applied.variables[0].value, 2);
  assert.equal(writes, 1);
});

it('controls only the exact skeletal component and preserves native method receivers', async () => {
  class Animation {} class Skeletal {}
  const clip = { name: 'walk', uuid: 'clip' };
  const state = { clip, isPlaying: false, isPaused: false };
  const scene = { uuid: 'scene', children: [] };
  const node = { uuid: 'node', children: [], parent: scene, getComponents(ctor) { assert.equal(ctor, Skeletal); return [component]; } };
  const component = { uuid: 'skeletal', node, clips: [clip], getState(name) { assert.equal(this, component); assert.equal(name, clip.name); return state; }, play() { assert.equal(this, component); state.isPlaying = true; }, pause() { state.isPaused = true; }, resume() { state.isPaused = false; }, stop() { state.isPlaying = false; } };
  scene.children = [node];
  const cc = { GAME_VIEW: true, ENGINE_VERSION: '3.7.3', Animation, SkeletalAnimation: Skeletal, director: { getScene: () => scene }, isValid: () => true };
  const context = vm.createContext({ cc, setTimeout, clearTimeout, setInterval, clearInterval });
  const request = { sessionId: 's', nodeReference: { id: 'node' }, componentId: 'skeletal', kind: 'skeletal', operation: 'play', clipName: 'walk', clipUuid: 'clip' };
  const played = await vm.runInContext(createComponentOperationSource(request), context);
  assert.equal(played.componentType, 'cc.SkeletalAnimation');
  assert.equal(played.state.playing, true);
  request.clipUuid = 'foreign';
  const refused = await vm.runInContext(createComponentOperationSource(request), context);
  assert.equal(refused.code, 'ANIMATION_CLIP_NOT_FOUND');
  assert.equal(refused.mutationDispatched, false);
});

it('refuses unknown and non-3.7 runtime versions before target access', async () => {
  for (const version of [undefined, '3.8.8']) {
    const cc = { GAME_VIEW: true, ENGINE_VERSION: version, director: { getScene() { throw new Error('Must not inspect unsupported renderer'); } } };
    const context = vm.createContext({ cc });
    const result = await vm.runInContext(createComponentOperationSource({ kind: 'particle', operation: 'play', nodeReference: { id: 'node' } }), context);
    assert.equal(result.code, 'UNSUPPORTED_VERSION');
    assert.equal(result.mutationDispatched, false);
  }
});
