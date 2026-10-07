'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { RequestActivityStore } = requireDist('utcp/request-activity.js');

it('tracks bounded business request activity without payloads', () => {
  let now = 1000;
  const store = new RequestActivityStore(() => now);
  assert.equal(store.start('r1', 'nodeGetTree'), true);
  now = 1250;
  assert.deepEqual(store.snapshot(), {
    activeCount: 1,
    active: [{ requestId: 'r1', tool: 'nodeGetTree', startedAt: 1000, ageMs: 250 }],
    overflowCount: 0,
    lastReceived: { tool: 'nodeGetTree', receivedAt: 1000, ageMs: 250 },
    recentFinished: [],
  });
  now = 1400;
  store.finish('r1', 'nodeGetTree', 'completed', 200, 1000);
  assert.deepEqual(store.snapshot(), {
    activeCount: 0,
    active: [],
    overflowCount: 0,
    lastReceived: { tool: 'nodeGetTree', receivedAt: 1000, ageMs: 400 },
    recentFinished: [{ requestId: 'r1', tool: 'nodeGetTree', outcome: 'completed', status: 200, finishedAt: 1400, durationMs: 400 }],
  });
});

it('excludes heartbeat and health traffic from tool request idle age', () => {
  let now = 1000;
  const store = new RequestActivityStore(() => now);
  assert.equal(store.start('h1', 'editorHandshake'), false);
  assert.equal(store.start('h2', 'editorSessionHeartbeat'), false);
  store.finish('h1', 'editorHandshake', 'completed', 200, 1000);
  assert.deepEqual(store.snapshot(), { activeCount: 0, active: [], overflowCount: 0, lastReceived: null, recentFinished: [] });
  store.start('r1', 'nodeGetTree');
  now = 6000;
  store.start('h3', 'editorHandshake');
  assert.deepEqual(store.snapshot().lastReceived, { tool: 'nodeGetTree', receivedAt: 1000, ageMs: 5000 });
});

it('bounds visible requests while retaining the exact active count', () => {
  const store = new RequestActivityStore(() => 1000);
  for (let index = 0; index < 25; index++) store.start(`r${index}`, `tool${index}`);
  const active = store.snapshot();
  assert.equal(active.activeCount, 25);
  assert.equal(active.active.length, 20);
  assert.equal(active.overflowCount, 5);
  store.finish('r24', 'tool24', 'failed', 500, 900);
  assert.equal(store.snapshot().activeCount, 24);
  store.clear();
  assert.deepEqual(store.snapshot(), { activeCount: 0, active: [], overflowCount: 0, lastReceived: null, recentFinished: [] });
});

it('keeps only 20 recent completions newest first and excludes health traffic', () => {
  let now = 1000;
  const store = new RequestActivityStore(() => now);
  for (let index = 0; index < 25; index++) {
    const id = `r${index}`;
    store.start(id, `tool${index}`);
    now += 10;
    store.finish(id, `tool${index}`, index === 24 ? 'failed' : 'completed', index === 24 ? 500 : 200, now - 10);
  }
  const history = store.snapshot().recentFinished;
  assert.equal(history.length, 20);
  assert.deepEqual(history.map((entry) => entry.requestId), Array.from({ length: 20 }, (_, index) => `r${24 - index}`));
  assert.deepEqual([history[0].outcome, history[0].status, history[0].durationMs], ['failed', 500, 10]);
  store.finish('health', 'editorHandshake', 'completed', 200, now);
  assert.equal(store.snapshot().recentFinished.length, 20);
  history[0].tool = 'mutated';
  assert.equal(store.snapshot().recentFinished[0].tool, 'tool24');
});
