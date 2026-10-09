'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.CCP_GRANT_DEVICE_ID = '11111111-1111-4111-8111-111111111111';
process.env.CCP_GRANT_PROJECT_ID = 'project-opaque';
process.env.CCP_GRANT_OPERATION_CLASS = 'mutation';
process.env.CCP_GRANT_EXPIRES_AT_MS = String(Date.now() + 60_000);
const { grantBody } = require('../../scripts/manage-device');

test('admin grant CLI emits only the bounded grant fields', () => {
  const body = grantBody();
  assert.deepEqual(Object.keys(body).sort(), ['deviceId', 'expiresAtMs', 'operationClass', 'projectId']);
  assert.equal(body.operationClass, 'mutation');
  assert.equal(body.projectId, 'project-opaque');
});
