'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { requireDist } = require('../helpers/require-dist');

const { LocalHttpServer, sendJson } = requireDist('utcp/http-server.js');
const { extractIdempotencyKey } = requireDist('utcp/local-auth.js');

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const auth = {
  relayInstanceId: INSTANCE_ID,
  token: 'x'.repeat(43),
  tokenPath: 'unused-in-retry-test.env',
  variableName: 'CCP_LOCAL_TOKEN',
};
const baseHeaders = {
  'content-type': 'application/json',
  'x-ccp-local-token': auth.token,
  'x-ccp-relay-instance': INSTANCE_ID,
};

describe('local protected retry transport', () => {
  it('forwards the stable idempotency header exactly', async () => {
    const server = new LocalHttpServer(auth);
    let dispatched;
    server.route('POST', '/protected', ({ request, response }) => {
      dispatched = extractIdempotencyKey(request);
      sendJson(response, 200, { ok: true });
    });
    const port = await server.listen(0);
    try {
      const key = 'retry_Key-1234567890';
      const response = await fetch(`http://127.0.0.1:${port}/protected`, {
        method: 'POST', headers: { ...baseHeaders, 'x-ccp-idempotency-key': key }, body: '{}',
      });
      assert.equal(response.status, 200);
      assert.equal(dispatched, key);
    } finally {
      await server.close();
    }
  });

  it('rejects conflicting and oversized retry values before protected dispatch', async () => {
    const server = new LocalHttpServer(auth);
    let protectedDispatches = 0;
    server.route('POST', '/protected', ({ request, response }) => {
      const key = extractIdempotencyKey(request);
      protectedDispatches += 1;
      sendJson(response, 200, { ok: true, key });
    });
    const port = await server.listen(0);
    try {
      const conflicting = await new Promise((resolve, reject) => {
        const request = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/protected',
          method: 'POST',
          joinDuplicateHeaders: false,
          headers: {
            'content-type': 'application/json',
            'content-length': '2',
            'x-ccp-local-token': auth.token,
            'x-ccp-relay-instance': INSTANCE_ID,
            'x-ccp-idempotency-key': ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
          },
        }, resolve);
        request.once('error', reject);
        request.end('{}');
      });
      assert.equal(conflicting.statusCode, 409);
      conflicting.resume();

      const oversized = await fetch(`http://127.0.0.1:${port}/protected`, {
        method: 'POST', headers: { ...baseHeaders, 'x-ccp-idempotency-key': 'a'.repeat(129) }, body: '{}',
      });
      assert.equal(oversized.status, 413);
      assert.equal(protectedDispatches, 0);
    } finally {
      await server.close();
    }
  });
});
