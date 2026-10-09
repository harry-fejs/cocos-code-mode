'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');

const { LocalHttpServer, sendJson } = requireDist('utcp/http-server.js');

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const auth = {
  relayInstanceId: INSTANCE_ID,
  token: 'x'.repeat(43),
  tokenPath: 'unused-in-http-test.env',
  variableName: 'CCP_LOCAL_TOKEN',
};
function headersFor(boundAuth = auth) {
  return {
    'content-type': 'application/json',
    'x-ccp-local-token': boundAuth.token,
    'x-ccp-relay-instance': boundAuth.relayInstanceId,
    ...(boundAuth.boundPort === undefined ? {} : { 'x-ccp-bound-port': String(boundAuth.boundPort) }),
  };
}
const authenticatedHeaders = headersFor();

describe('finite native localhost HTTP server', () => {
  it('serves authenticated bounded JSON and denies missing, wrong, or cross-instance credentials', async () => {
    const server = new LocalHttpServer(auth);
    server.route('POST', '/echo', ({ body, query, response }) => sendJson(response, 200, { body, query }));
    const port = await server.listen(0);
    try {
      const missing = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).code, 'CCP_AUTH_REQUIRED');

      const wrong = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: 'POST', headers: { ...authenticatedHeaders, 'x-ccp-local-token': 'y'.repeat(43) }, body: '{}',
      });
      assert.equal(wrong.status, 401);
      assert.equal((await wrong.json()).code, 'CCP_AUTH_REQUIRED');

      const crossInstance = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: 'POST', headers: { ...authenticatedHeaders, 'x-ccp-relay-instance': '22222222-2222-4222-8222-222222222222' }, body: '{}',
      });

      const portAuthServer = new LocalHttpServer({ ...auth, boundPort: port + 1 });
      portAuthServer.route('POST', '/echo', ({ response }) => sendJson(response, 200, { ok: true }));
      const boundPort = await portAuthServer.listen(0);
      try {
        const wrongPort = await fetch(`http://127.0.0.1:${boundPort}/echo`, {
          method: 'POST',
          headers: { ...headersFor({ ...auth, boundPort: port + 1 }), 'x-ccp-bound-port': String(port + 2) },
          body: '{}',
        });
        assert.equal(wrongPort.status, 401);
      } finally {
        await portAuthServer.close();
      }
      assert.equal(crossInstance.status, 401);
      assert.equal((await crossInstance.json()).code, 'CCP_AUTH_INVALID');

      const accepted = await fetch(`http://127.0.0.1:${port}/echo?count=2&enabled=true`, {
        method: 'POST', headers: authenticatedHeaders, body: JSON.stringify({ value: 'ok' }),
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), { body: { value: 'ok' }, query: { count: 2, enabled: true } });
    } finally {
      await server.close();
    }
  });

  it('rejects new work during drain and awaits the request already in flight', async () => {
    const server = new LocalHttpServer(auth);
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    server.route('POST', '/slow', async ({ response }) => {
      entered();
      await gate;
      sendJson(response, 200, { ok: true });
    });
    const port = await server.listen(0);
    const active = fetch(`http://127.0.0.1:${port}/slow`, {
      method: 'POST', headers: authenticatedHeaders, body: '{}',
    });
    await started;

    server.beginDrain();
    const denied = await fetch(`http://127.0.0.1:${port}/slow`, {
      method: 'POST', headers: authenticatedHeaders, body: '{}',
    });
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).code, 'CCP_BUSY');

    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    assert.deepEqual(await (await active).json(), { ok: true });
    await closing;
    assert.equal(closed, true);
  });
});
