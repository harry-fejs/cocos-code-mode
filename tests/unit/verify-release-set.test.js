'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function writeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-verify-'));
  const origin = 'https://192.168.20.100:8788/';
  const artifactBytes = {
    'release.zip': Buffer.from('zip'),
    'package-manifest.json': Buffer.from('manifest'),
    'sbom.cdx.json': Buffer.from('sbom'),
    'provenance.intoto.json': Buffer.from('provenance'),
  };
  for (const [name, bytes] of Object.entries(artifactBytes)) fs.writeFileSync(path.join(root, name), bytes);
  const targetBody = {
    package: {
      name: 'ccp3x',
      version: '2.0.0',
      url: `${origin}release.zip`,
      sha256: hash(artifactBytes['release.zip']),
      packageManifestSha256: hash(artifactBytes['package-manifest.json']),
      sbomSha256: hash(artifactBytes['sbom.cdx.json']),
      provenanceSha256: hash(artifactBytes['provenance.intoto.json']),
    },
  };
  const targetBytes = Buffer.from(canonicalize(targetBody));
  const policyBody = { targetPayloadSha256: hash(targetBytes), policySequence: 1 };
  fs.mkdirSync(path.join(root, 'metadata'));
  for (const [name, value] of [['target', targetBody], ['policy', policyBody], ['root', { schemaVersion: 1 }]]) {
    const payload = Buffer.from(canonicalize(value)).toString('base64url');
    fs.writeFileSync(path.join(root, 'metadata', `${name}.json`), JSON.stringify({ payload, signatures: [{ keyId: 'test', signature: 'test' }] }));
  }
  return { root, origin };
}

const script = path.resolve(__dirname, '..', '..', 'scripts', 'verify-release-set.js');

test('release verifier accepts a complete consistently bound release set', () => {
  const fixture = writeFixture();
  const result = spawnSync(process.execPath, [script], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, CCP_RELEASE_DIRECTORY: fixture.root, CCP_RELEASE_ORIGIN: fixture.origin },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"packageVersion": "2.0.0"/);
});

test('release verifier fails closed when the release origin is not configured', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, CCP_RELEASE_DIRECTORY: fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-verify-')), CCP_RELEASE_ORIGIN: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CCP_RELEASE_ORIGIN/);
});
