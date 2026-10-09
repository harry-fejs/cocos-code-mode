'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { requireDist } = require('../helpers/require-dist');

const { assertReleaseOrigin, downloadReleaseArtifact, fetchReleaseJson } = requireDist('update/client.js');

describe('bounded release client', { concurrency: false }, () => {
  const origin = assertReleaseOrigin('https://releases.example.test/');

  it('requires an exact origin and rejects foreign redirects', async () => {
    assert.throws(() => assertReleaseOrigin('https://releases.example.test/path'), /exact HTTPS origin/);
    const prior = global.fetch;
    global.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/release.json' } });
    try {
      await assert.rejects(() => fetchReleaseJson(origin, 'https://releases.example.test/release.json', 1024), /stay on the HTTPS release origin/);
    } finally { global.fetch = prior; }
  });

  it('reads only the declared JSON bytes and rejects truncation', async () => {
    const prior = global.fetch;
    const body = Buffer.from('{"ok":true}');
    global.fetch = async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    try {
      assert.deepEqual(await fetchReleaseJson(origin, 'https://releases.example.test/release.json', 1024), { ok: true });
      global.fetch = async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length + 1) } });
      await assert.rejects(() => fetchReleaseJson(origin, 'https://releases.example.test/release.json', 1024), /truncated/);
    } finally { global.fetch = prior; }
  });

  it('streams an exact artifact to an atomic destination and removes a bad partial', async () => {
    const prior = global.fetch;
    const root = mkdtempSync(join(tmpdir(), 'ccp-download-'));
    const body = Buffer.from('signed release artifact');
    const sha256 = createHash('sha256').update(body).digest('hex');
    try {
      global.fetch = async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
      const destination = join(root, 'release.zip');
      await downloadReleaseArtifact(origin, 'https://releases.example.test/release.zip', destination, body.length, sha256);
      assert.deepEqual(readFileSync(destination), body);
      global.fetch = async () => new Response(Buffer.from('bad'), { status: 200, headers: { 'content-length': '3' } });
      const bad = join(root, 'bad.zip');
      await assert.rejects(() => downloadReleaseArtifact(origin, 'https://releases.example.test/bad.zip', bad, 3, sha256), /size or hash/);
      assert.equal(existsSync(bad), false);
      assert.equal(existsSync(`${bad}.partial`), false);
    } finally {
      global.fetch = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
