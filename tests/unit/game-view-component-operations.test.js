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
  const cc = { GAME_VIEW: true, director: { getScene: () => scene }, js: { getClassByName: name => name === 'cc.ParticleSystem' ? Particle : undefined }, isValid: () => true };
  const context = vm.createContext({ cc, setTimeout, clearTimeout, setInterval, clearInterval });
  const request = { sessionId: 'session', nodeReference: { id: 'particle' }, kind: 'particle', operation: 'play', timeoutMs: 1000 };
  const played = await vm.runInContext(createComponentOperationSource(request), context);
  assert.equal(played.state.playing, true);
  assert.equal(commands, 1);
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
  const cc = { GAME_VIEW: true, director: { getScene: () => scene }, js: { getClassByName: () => Controller }, isValid: () => true };
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
