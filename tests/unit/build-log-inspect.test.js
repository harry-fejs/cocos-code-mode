'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');

const { BuildTools } = requireDist('utcp/tools/build-tools.js');

afterEach(() => { delete global.Editor; });

describe('buildLogInspect', () => {
  it('queries one task and normalizes bounded diagnostics without dispatching a build', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (...args) => {
      calls.push(args);
      return {
        id: 'task-1', progress: 0.75, state: 'failure', message: 'Build failed', stage: 'build',
        detailMessage: [
          { level: 'error', code: 'E_BUILD', file: 'assets/main.ts', line: 12, message: 'Compilation failed' },
          'assets/other.ts(7,2): warning TS999: Deprecated API',
          'informational note',
        ],
        options: { taskName: 'candidate-build', platform: 'web-mobile' },
      };
    } } };

    const result = await new BuildTools().buildLogInspect({ taskId: 'task-1', maxEntries: 2, maxBytes: 4096 });
    assert.deepEqual(calls, [['builder', 'query-task', 'task-1']]);
    assert.equal(result.available, true);
    assert.equal(result.terminal, true);
    assert.equal(result.state, 'failure');
    assert.equal(result.progress, 0.75);
    assert.equal(result.count, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.entries[0], { message: 'Compilation failed', severity: 'error', code: 'E_BUILD', file: 'assets/main.ts', line: 12 });
    assert.deepEqual(result.entries[1], { message: 'Deprecated API', severity: 'warning', code: 'TS999', file: 'assets/other.ts', line: 7 });
  });

  it('reports exposed task state with unavailable logs and never fabricates entries', async () => {
    global.Editor = { Message: { request: async () => ({ id: 'task-2', progress: 1, state: 'success' }) } };
    const result = await new BuildTools().buildLogInspect({ taskId: 2 });
    assert.equal(result.available, false);
    assert.deepEqual(result.entries, []);
    assert.equal(result.count, 0);
    assert.equal(result.truncated, false);
  });

  it('enforces the serialized whole-response byte bound', async () => {
    global.Editor = {
      Message: {
        request: async () => ({
          id: 'task-bytes', progress: 1, state: 'success',
          logs: [`error E_TOO_LONG: ${'x'.repeat(600)}`],
        }),
      },
    };
    const result = await new BuildTools().buildLogInspect({ taskId: 'task-bytes', maxBytes: 256 });
    assert.equal(result.available, true);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 256);
  });

  it('counts UTF-8, JSON escapes, duplicate state, and count digit growth at the exact limit', async () => {
    const message = '雪"\\\t\u0000';
    global.Editor = { Message: { request: async () => ({
      id: 'task-雪"\\', progress: 0.125, state: 'building-雪"\\',
      logs: Array.from({ length: 10 }, () => ({ message })),
    }) } };
    const tools = new BuildTools();
    const complete = await tools.buildLogInspect({ taskId: 'task-雪"\\' });
    assert.equal(complete.count, 10);
    assert.equal(complete.truncated, false);
    assert.deepEqual(complete.entries, Array.from({ length: 10 }, () => ({ message })));
    const maxBytes = Buffer.byteLength(JSON.stringify(complete), 'utf8');
    const exact = await tools.buildLogInspect({ taskId: 'task-雪"\\', maxBytes });
    assert.deepEqual(exact, complete);
    const bounded = await tools.buildLogInspect({ taskId: 'task-雪"\\', maxBytes: maxBytes - 1 });
    assert.equal(bounded.count, 9);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.task.id, complete.task.id);
    assert.equal(bounded.task.state, complete.task.state);
    assert.equal(bounded.state, complete.state);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= maxBytes - 1);
  });

  it('omits oversized optional metadata but preserves identity, state and useful diagnostics', async () => {
    const huge = '雪"\\'.repeat(1000);
    global.Editor = { Message: { request: async () => ({
      id: 'task-meta', progress: 0.5, state: 'building', message: huge, time: huge, stage: huge, dirty: false,
      options: { name: huge, platform: huge, buildPath: huge },
      logs: ['informational note'],
    }) } };
    const result = await new BuildTools().buildLogInspect({ taskId: 'task-meta', maxBytes: 256 });
    assert.deepEqual(result.task, { id: 'task-meta', progress: 0.5, state: 'building', dirty: false });
    assert.deepEqual(result.entries, [{ message: 'informational note' }]);
    assert.equal(result.count, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.available, true);
    assert.equal(result.terminal, false);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 256);
  });

  it('keeps logs unavailable even when optional metadata is truncated', async () => {
    global.Editor = { Message: { request: async () => ({
      id: 'task-unavailable', progress: 1, state: 'success', message: 'large'.repeat(1000),
    }) } };
    const result = await new BuildTools().buildLogInspect({ taskId: 'task-unavailable', maxBytes: 256 });
    assert.equal(result.available, false);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.entries, []);
    assert.equal(result.count, 0);
    assert.equal(result.task.message, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 256);
  });

  it('rejects mandatory identity or state exhaustion rather than slicing required fields', async () => {
    const calls = [];
    for (const oversized of [{ id: '雪"\\'.repeat(80) }, { state: 'building'.repeat(1000) }]) {
      const task = { id: 'task-large', progress: 0.5, state: 'building', ...oversized };
      global.Editor = { Message: { request: async (...args) => { calls.push(args); return task; } } };
      await assert.rejects(
        new BuildTools().buildLogInspect({ taskId: 'task-large', maxBytes: 256 }),
        (error) => error.code === 'BUILD_LOG_RESPONSE_TOO_LARGE' && error.status === 422,
      );
      const result = await new BuildTools().buildLogInspect({ taskId: 'task-large', maxBytes: 65536 });
      assert.deepEqual(result.task, task);
      assert.equal(result.state, task.state);
      assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 65536);
    }
    assert.deepEqual(calls, Array.from({ length: 4 }, () => ['builder', 'query-task', 'task-large']));
  });

  it('rejects invalid direct-call limits before querying Creator', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (...args) => { calls.push(args); return null; } } };
    const invalidLimits = [
      ...[NaN, Infinity, -Infinity, null, '2', 0, 1.5, 257].map((maxEntries) => ({ maxEntries })),
      ...[NaN, Infinity, -Infinity, null, '256', 255, 256.5, 2 * 1024 * 1024 + 1].map((maxBytes) => ({ maxBytes })),
    ];
    for (const limits of invalidLimits) {
      await assert.rejects(
        new BuildTools().buildLogInspect({ taskId: 'task-limits', ...limits }),
        (error) => error.code === 'INVALID_ARGUMENT' && error.status === 400,
      );
    }
    assert.deepEqual(calls, []);
  });

  it('accepts both schema limit endpoints and normalizes multiline logs lazily', async () => {
    global.Editor = { Message: { request: async () => ({
      id: 'task-limits', progress: 1, state: 'success',
      logs: '\r\n  \nerror E_BUILD: failed\r\nwarning TS999: deprecated\n',
    }) } };
    const tools = new BuildTools();
    const minimum = await tools.buildLogInspect({ taskId: 'task-limits', maxEntries: 1, maxBytes: 256 });
    assert.deepEqual(minimum.entries, [{ message: 'failed', severity: 'error', code: 'E_BUILD' }]);
    assert.equal(minimum.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(minimum), 'utf8') <= 256);
    const maximum = await tools.buildLogInspect({ taskId: 'task-limits', maxEntries: 256, maxBytes: 2 * 1024 * 1024 });
    assert.deepEqual(maximum.entries, [
      { message: 'failed', severity: 'error', code: 'E_BUILD' },
      { message: 'deprecated', severity: 'warning', code: 'TS999' },
    ]);
    assert.equal(maximum.truncated, false);
  });
  it('rejects malformed task summaries and skips unusable log fields', async () => {
    global.Editor = { Message: { request: async () => ({
      id: 'task-valid', progress: 0.5, state: 'success',
      logs: { unsupported: true },
      detailMessage: [{ message: 'usable diagnostic' }],
    }) } };
    const result = await new BuildTools().buildLogInspect({ taskId: 'task-valid' });
    assert.deepEqual(result.entries, [{ message: 'usable diagnostic' }]);
    global.Editor = { Message: { request: async () => ({ id: 'bad', progress: 'bad', state: 'success' }) } };
    await assert.rejects(new BuildTools().buildLogInspect({ taskId: 'bad' }), (error) => error.code === 'BUILD_TASK_INVALID_RESPONSE' && error.status === 502);
  });


  it('returns typed not-found and query failures', async () => {
    global.Editor = { Message: { request: async () => null } };
    await assert.rejects(new BuildTools().buildLogInspect({ taskId: 'missing' }), (error) => error.code === 'TARGET_NOT_FOUND' && error.status === 404);
    global.Editor = { Message: { request: async () => { throw new Error('builder offline'); } } };
    await assert.rejects(new BuildTools().buildLogInspect({ taskId: 'offline' }), (error) => error.code === 'BUILD_TASK_QUERY_FAILED' && error.status === 502);
  });
});
