'use strict';

const { createPrivateKey, sign } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalize } = require('./sign-release');
const { readCredential } = require('./credential-input');

const origin = new URL(process.env.CCP_GATEWAY_ORIGIN || 'http://127.0.0.1:8787');
const credential = readCredential('CCP_MEMBER_CREDENTIAL', 'CCP_MEMBER_CREDENTIAL_FILE');
const label = process.env.CCP_DEVICE_LABEL || os.hostname().slice(0, 64);
const identityPath = path.resolve(process.env.CCP_DEVICE_IDENTITY_PATH || path.join(os.homedir(), '.ccp', 'identity', 'device-identity-v1.json'));

function fail(message) { throw new Error(message); }
function validateOrigin() {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)) fail('CCP_GATEWAY_ORIGIN must be an exact origin');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback && process.env.CCP_ALLOW_INSECURE_GATEWAY === '1')) {
    fail('Gateway must use HTTPS, except explicit loopback qualification');
  }
}
function readIdentity() {
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  if (identity.schemaVersion !== 1 || typeof identity.deviceId !== 'string' || typeof identity.deviceKeyId !== 'string'
    || typeof identity.publicKeyDer !== 'string' || typeof identity.privateKeyDer !== 'string') fail('device identity is invalid');
  return identity;
}
async function post(relative, body) {
  if (!credential) fail('CCP_MEMBER_CREDENTIAL is required');
  const response = await fetch(new URL(relative, `${origin.origin}/`), {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { fail(`Gateway returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) fail(`Gateway HTTP ${response.status}: ${value.code || value.error || 'request denied'}`);
  return value;
}
function createProof(identity, challenge) {
  const body = {
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    memberId: challenge.memberId,
    label: challenge.label,
    expiresAtMs: challenge.expiresAtMs,
    deviceId: identity.deviceId,
    deviceKeyId: identity.deviceKeyId,
    publicKeySpki: identity.publicKeyDer,
  };
  const key = createPrivateKey({ key: Buffer.from(identity.privateKeyDer, 'base64url'), format: 'der', type: 'pkcs8' });
  const signatureBase = Buffer.from(canonicalize({ domain: 'ccp-device-enrollment-v1', ...body }), 'utf8');
  return { ...body, proofSignature: sign(null, signatureBase, key).toString('base64url') };
}
async function main() {
  validateOrigin();
  if (!label || label.length > 64) fail('CCP_DEVICE_LABEL must contain 1..64 characters');
  const identity = readIdentity();
  const challenge = await post('ccp/v1/devices/challenge', { label });
  const enrolled = await post('ccp/v1/devices/enroll', createProof(identity, challenge));
  console.log(JSON.stringify({ ...enrolled, deviceKeyId: identity.deviceKeyId, label }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(`enroll-device failed: ${error.message}`); process.exitCode = 1; });
module.exports = { createProof, validateOrigin };
