'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preflightReferencedInputBytes } = require('../../dist/protected/value-resolver');

const request = { inputs: { value: 'é' } };
const reference = { source: 'request', jsonPointer: '/inputs/value' };
const envelope = (args, inputBytes) => ({ commands: [{ args }], limits: { inputBytes } });

test('zero signed input budget permits no references but rejects request data', () => {
  assert.equal(preflightReferencedInputBytes(envelope({}, 0), request, {}), 0);
  assert.throws(() => preflightReferencedInputBytes(envelope({ value: reference }, 0), request, {}),
    error => error.body.code === 'CCP_LIMIT_EXCEEDED');
});

test('signed budget counts each UTF-8 request reference occurrence', () => {
  const args = { first: reference, second: reference };
  assert.equal(preflightReferencedInputBytes(envelope(args, 8), request, {}), 8);
  assert.throws(() => preflightReferencedInputBytes(envelope(args, 7), request, {}),
    error => error.body.code === 'CCP_LIMIT_EXCEEDED');
});
