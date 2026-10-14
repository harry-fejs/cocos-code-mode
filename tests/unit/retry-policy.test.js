'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { ToolError } = requireDist('utcp/tool-error.js');
const { retryTransient, isRetrySafeTransient, MAX_TRANSIENT_RETRIES } = requireDist('utcp/utils/retry-policy.js');

it('retries only safe transient failures and stops at three attempts', async () => {
  let calls = 0;
  const result = await retryTransient(async () => {
    calls++;
    if (calls < 3) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, details: { retrySafe: true, mutationDispatched: false } });
    return 'ok';
  }, { delayMs: 0 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.equal(MAX_TRANSIENT_RETRIES, 3);
});

it('never retries dispatched or non-transient failures', async () => {
  let calls = 0;
  const dispatched = new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, details: { retrySafe: true, mutationDispatched: true } });
  assert.equal(isRetrySafeTransient(dispatched), false);
  await assert.rejects(retryTransient(async () => { calls++; throw dispatched; }, { delayMs: 0 }), error => error === dispatched);
  assert.equal(calls, 1);
  const invalid = new ToolError({ code: 'INVALID_ARGUMENT', status: 400, details: { retrySafe: true, mutationDispatched: false } });
  assert.equal(isRetrySafeTransient(invalid), false);
});

it('preserves the final transient error after exhausting exactly three attempts', async () => {
  let calls = 0;
  const failure = new ToolError({ code: 'ASSET_QUERY_FAILED', message: 'temporary transport', details: { retrySafe: true, mutationDispatched: false } });
  await assert.rejects(retryTransient(async () => { calls++; throw failure; }, { delayMs: 0 }), error => error === failure);
  assert.equal(calls, 3);
});

it('refuses uncertain outcomes even when retrySafe is incorrectly true', async () => {
  for (const uncertainty of [{ outcome: 'unknown' }, { submission: 'outcome-unknown' }, { pendingMayComplete: true }]) {
    let calls = 0;
    const error = new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', message: 'uncertain', details: { retrySafe: true, ...uncertainty } });
    await assert.rejects(retryTransient(async () => { calls++; throw error; }, { delayMs: 0 }), failure => failure === error);
    assert.equal(calls, 1);
  }
});

it('rejects non-finite or fractional retry limits before invoking the operation', async () => {
  let calls = 0;
  for (const options of [{ attempts: NaN }, { attempts: 1.5 }, { attempts: 4 }, { delayMs: Infinity }]) {
    await assert.rejects(retryTransient(async () => { calls++; }, options), error => error.code === 'INVALID_ARGUMENT');
  }
  assert.equal(calls, 0);
});

it('does not dispatch after deadline or schedule a retry beyond the caller budget', async () => {
  let calls = 0;
  await assert.rejects(retryTransient(async () => { calls++; }, { deadline: 0 }), error => error.code === 'RUNTIME_STATE_TIMEOUT');
  assert.equal(calls, 0);
  const failure = new ToolError({ code: 'ASSET_QUERY_FAILED', message: 'temporary', details: { retrySafe: true, mutationDispatched: false } });
  await assert.rejects(retryTransient(async () => { calls++; throw failure; }, { delayMs: 1000, deadline: Date.now() + 500 }), error => error === failure);
  assert.equal(calls, 1);
});
