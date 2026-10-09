'use strict';

const { createPrivateKey, createPublicKey, sign, verify } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, decodeBase64UrlStrict } = require('./sign-release');

const ROOT_PREFIX = Buffer.from('CCP1 release-root\n', 'utf8');
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const projectRoot = path.join(__dirname, '..');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function readCanonicalRoot(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 1 || bytes.length > 256 * 1024) throw new Error('release root payload exceeds bounds');
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('release root payload is not valid JSON'); }
  const canonical = Buffer.from(canonicalize(body), 'utf8');
  if (!bytes.equals(canonical)) throw new Error('release root payload must be canonical JSON without trailing bytes');
  if (body.schemaVersion !== 1 || body.product !== 'ccp3x' || !Number.isSafeInteger(body.rootVersion) || body.rootVersion < 1) {
    throw new Error('release root identity is invalid');
  }
  return bytes;
}
function signRoot(payload, keyId, privateKeyBase64Url, publicKeyBase64Url) {
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error('invalid key ID');
  const privateKey = createPrivateKey({ key: decodeBase64UrlStrict(privateKeyBase64Url), format: 'der', type: 'pkcs8' });
  const message = Buffer.concat([ROOT_PREFIX, payload]);
  const signature = sign(null, message, privateKey);
  if (signature.length !== 64) throw new Error('Ed25519 produced an unexpected signature length');
  if (publicKeyBase64Url) {
    const publicKey = createPublicKey({ key: decodeBase64UrlStrict(publicKeyBase64Url), format: 'der', type: 'spki' });
    if (!verify(null, message, publicKey, signature)) throw new Error('self-verify failed');
  }
  return { keyId, signature: signature.toString('base64url') };
}
function existingSignatures(filePath, payload) {
  if (!filePath) return [];
  const wrapper = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (wrapper.payload !== payload.toString('base64url') || !Array.isArray(wrapper.signatures)) {
    throw new Error('existing root wrapper does not match the canonical root payload');
  }
  if (wrapper.signatures.length > 15) throw new Error('root wrapper cannot exceed 16 signatures');
  return wrapper.signatures;
}
function main() {
  const payloadPath = path.resolve(requiredEnv('CCP_RELEASE_ROOT_PATH'));
  const payload = readCanonicalRoot(payloadPath);
  const prior = existingSignatures(process.argv[2] ? path.resolve(process.argv[2]) : undefined, payload);
  const signature = signRoot(
    payload,
    requiredEnv('CCP_RELEASE_ROOT_KEY_ID'),
    requiredEnv('CCP_RELEASE_ROOT_PRIVATE_KEY'),
    process.env.CCP_RELEASE_ROOT_PUBLIC_KEY,
  );
  if (prior.some((entry) => entry && entry.keyId === signature.keyId)) throw new Error('root wrapper already contains this key ID');
  const wrapper = { payload: payload.toString('base64url'), signatures: [...prior, signature] };
  const outPath = path.join(projectRoot, 'dist', 'release-root.signed.json');
  fs.writeFileSync(outPath, `${JSON.stringify(wrapper, null, 2)}\n`);
  console.log(JSON.stringify({ outPath, signatures: wrapper.signatures.map((entry) => entry.keyId) }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`sign-root failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { readCanonicalRoot, signRoot };
