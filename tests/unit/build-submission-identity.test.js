'use strict';
const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { BuildTools } = requireDist('utcp/tools/build-tools.js');
afterEach(() => { delete global.Editor; });
it('refuses a scalar acknowledgment that does not identify a queued task without resubmitting', async () => {
  let submissions = 0;
  global.Editor = { Message: { request: async (_package, message, value) => {
    if (message === 'add-task') { submissions++; return 1; }
    if (message === 'query-task') { assert.equal(value, '1'); return null; }
    throw Error('Unexpected request');
  } } };
  await assert.rejects(new BuildTools().buildTrigger({ options: { platform: 'web-mobile', taskId: 'caller-task' } }), error => error.code === 'BUILD_SUBMISSION_OUTCOME_UNKNOWN' && error.details.retrySafe === false);
  assert.equal(submissions, 1);
});
it('reports submitted only when the returned identity matches native task readback', async () => {
  global.Editor = { Message: { request: async (_package, message) => message === 'add-task' ? 'native-task' : { id: 'native-task', state: 'processing' } } };
  assert.deepEqual(await new BuildTools().buildTrigger({ options: { platform: 'web-mobile' } }), { success: true, submission: 'submitted', taskId: 'native-task' });
});
