'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync, verify } = require('node:crypto');
const { test } = require('node:test');
const { canonicalize } = require('../../scripts/sign-release');
const { createProof } = require('../../scripts/enroll-device');

test('device enrollment CLI signs the exact Gateway proof contract', () => {
  const pair = generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  const privateDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  const identity = {
    schemaVersion: 1,
    deviceId: '11111111-1111-4111-8111-111111111111',
    deviceKeyId: 'device-test',
    publicKeyDer: publicDer.toString('base64url'),
    privateKeyDer: privateDer.toString('base64url'),
  };
  const challenge = {
    challengeId: '22222222-2222-4222-8222-222222222222',
    challenge: Buffer.alloc(32, 7).toString('base64url'),
    memberId: 'member-test',
    label: 'qualification-device',
    expiresAtMs: 2_000_000_000_000,
  };
  const proof = createProof(identity, challenge);
  const { proofSignature, ...body } = proof;
  const message = Buffer.from(canonicalize({ domain: 'ccp-device-enrollment-v1', ...body }));
  assert.equal(verify(null, message, pair.publicKey, Buffer.from(proofSignature, 'base64url')), true);
  assert.equal(proof.deviceId, identity.deviceId);
  assert.equal(proof.deviceKeyId, identity.deviceKeyId);
});
