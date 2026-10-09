'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync, verify } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { canonicalize } = require('../../scripts/sign-release');
const { readCanonicalRoot, signRoot } = require('../../scripts/sign-root');

test('root signer signs the canonical release-root domain', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const body = {
    schemaVersion: 1,
    product: 'ccp3x',
    rootVersion: 1,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    keys: { root: { algorithm: 'Ed25519', spkiDer: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') } },
    roles: { root: { keyIds: ['root'], threshold: 1 }, targets: { keyIds: ['root'], threshold: 1 }, policy: { keyIds: ['root'], threshold: 1 } },
  };
  const payload = Buffer.from(canonicalize(body));
  const signature = signRoot(payload, 'root', privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'), publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'));
  assert.equal(verify(null, Buffer.concat([Buffer.from('CCP1 release-root\n'), payload]), publicKey, Buffer.from(signature.signature, 'base64url')), true);
});

test('root signer rejects noncanonical bootstrap payloads', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-root-'));
  try {
    const file = path.join(temp, 'root.json');
    fs.writeFileSync(file, '{ "schemaVersion": 1 }\n');
    assert.throws(() => readCanonicalRoot(file), /canonical JSON/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
