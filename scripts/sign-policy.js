'use strict';

const { createPrivateKey, createPublicKey, sign, verify } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, decodeBase64UrlStrict } = require('./sign-release');

const POLICY_PREFIX = Buffer.from('CCP1 rollout-policy\n', 'utf8');
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const projectRoot = path.join(__dirname, '..');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function exactIso(name) {
  const value = requiredEnv(name);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return value;
}
function rollbackTargets() {
  const value = process.env.CCP_POLICY_ROLLBACK_TARGET_SHA256;
  if (!value) return [];
  const targets = value.split(',').map((entry) => entry.trim());
  if (targets.length > 8 || targets.some((entry) => !SHA256_PATTERN.test(entry))) {
    throw new Error('CCP_POLICY_ROLLBACK_TARGET_SHA256 must contain at most 8 comma-separated SHA-256 digests');
  }
  return [...new Set(targets)];
}


function buildPolicyBody() {
  const targetPayloadSha256 = requiredEnv('CCP_POLICY_TARGET_SHA256');
  if (!SHA256_PATTERN.test(targetPayloadSha256)) throw new Error('CCP_POLICY_TARGET_SHA256 must be 64 hex chars');
  const ring = requiredEnv('CCP_POLICY_RING');
  if (!['1', '3', '10'].includes(ring)) throw new Error('CCP_POLICY_RING must be 1, 3, or 10');
  return {
    schemaVersion: 1,
    policySequence: positiveInteger('CCP_POLICY_SEQUENCE'),
    issuedAt: exactIso('CCP_POLICY_ISSUED_AT'),
    expiresAt: exactIso('CCP_POLICY_EXPIRES_AT'),
    targetPayloadSha256,
    channel: process.env.CCP_POLICY_CHANNEL || 'stable',
    ring,
    percentage: Number(process.env.CCP_POLICY_PERCENTAGE || '100'),
    recommended: process.env.CCP_POLICY_RECOMMENDED !== '0',
    blockedBuilds: [],
    rollbackTargetPayloadSha256: rollbackTargets(),
    disabledOperations: [],
    emergencyStop: process.env.CCP_POLICY_EMERGENCY_STOP === '1',
  };
}

function signPolicy(body, keyId, privateKeyBase64Url, publicKeyBase64Url) {
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error('invalid key ID');
  const privateKey = createPrivateKey({ key: decodeBase64UrlStrict(privateKeyBase64Url), format: 'der', type: 'pkcs8' });
  const payloadBytes = Buffer.from(canonicalize(body), 'utf8');
  const message = Buffer.concat([POLICY_PREFIX, payloadBytes]);
  const signatureBytes = sign(null, message, privateKey);
  if (signatureBytes.length !== 64) throw new Error('Ed25519 produced an unexpected signature length');
  if (publicKeyBase64Url) {
    const publicKey = createPublicKey({ key: decodeBase64UrlStrict(publicKeyBase64Url), format: 'der', type: 'spki' });
    if (!verify(null, message, publicKey, signatureBytes)) throw new Error('self-verify failed');
  }
  return { payload: payloadBytes.toString('base64url'), signatures: [{ keyId, signature: signatureBytes.toString('base64url') }] };
}

function main() {
  const body = buildPolicyBody();
  if (Date.parse(body.expiresAt) <= Date.parse(body.issuedAt)) throw new Error('rollout policy must expire after it is issued');
  const signed = signPolicy(
    body,
    requiredEnv('CCP_RELEASE_POLICY_KEY_ID'),
    requiredEnv('CCP_RELEASE_POLICY_PRIVATE_KEY'),
    process.env.CCP_RELEASE_POLICY_PUBLIC_KEY,
  );
  const outPath = path.join(projectRoot, 'dist', 'rollout-policy.signed.json');
  fs.writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(JSON.stringify({ outPath, ring: body.ring, policySequence: body.policySequence, targetPayloadSha256: body.targetPayloadSha256 }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`sign-policy failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { buildPolicyBody, rollbackTargets, signPolicy };
