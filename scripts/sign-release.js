'use strict';

const { createHash, createPrivateKey, createPublicKey, sign, verify } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TARGET_PREFIX = Buffer.from('CCP1 release-targets\n', 'utf8');
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const projectRoot = path.join(__dirname, '..');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function decodeBase64UrlStrict(value, exactBytes) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value) || value.includes('=')) {
    throw new Error('invalid unpadded base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.toString('base64url') !== value) throw new Error('invalid base64url encoding');
  if (exactBytes !== undefined && bytes.length !== exactBytes) throw new Error(`expected ${exactBytes} bytes, got ${bytes.length}`);
  return bytes;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function exactIso(name) {
  const value = requiredEnv(name);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(`${name} must be an exact ISO timestamp`);
  return value;
}

function artifact(relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`required release artifact missing: ${relativePath}`);
  const bytes = fs.readFileSync(filePath);
  return { filePath, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function readZip(explicitPath) {
  const candidate = explicitPath || fs.readdirSync(projectRoot).filter((name) => /^ccp3x.*\.zip$/.test(name)).sort().at(-1);
  if (!candidate) throw new Error('no ccp3x ZIP found; pass an explicit path');
  const filePath = path.resolve(projectRoot, candidate);
  if (!fs.existsSync(filePath)) throw new Error(`ZIP not found: ${filePath}`);
  const bytes = fs.readFileSync(filePath);
  return { filePath, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function assertHttpsArtifactUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('CCP_RELEASE_URL must be HTTPS without credentials or fragment');
  }
  return url.toString();
}

function buildReleaseTargetBody(zip, options = {}) {
  const manifestArtifact = artifact('dist/package-manifest.json');
  const sbomArtifact = artifact('dist/sbom.cdx.json');
  const provenanceArtifact = artifact('dist/provenance.intoto.json');
  const manifest = JSON.parse(manifestArtifact.bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.package !== 'ccp3x' || typeof manifest.version !== 'string') {
    throw new Error('package manifest identity is invalid');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('package manifest contains no files');
  for (const digest of [zip.sha256, manifestArtifact.sha256, sbomArtifact.sha256, provenanceArtifact.sha256]) {
    if (!SHA256_PATTERN.test(digest)) throw new Error('release artifact SHA-256 is malformed');
  }
  return {
    schemaVersion: 1,
    metadataVersion: options.metadataVersion ?? positiveInteger('CCP_RELEASE_METADATA_VERSION'),
    releaseSequence: options.releaseSequence ?? positiveInteger('CCP_RELEASE_SEQUENCE'),
    issuedAt: options.issuedAt ?? exactIso('CCP_RELEASE_ISSUED_AT'),
    expiresAt: options.expiresAt ?? exactIso('CCP_RELEASE_EXPIRES_AT'),
    package: {
      name: manifest.package,
      version: manifest.version,
      sha256: zip.sha256,
      size: zip.bytes.length,
      url: options.url ?? assertHttpsArtifactUrl(requiredEnv('CCP_RELEASE_URL')),
      packageManifestSha256: manifestArtifact.sha256,
      sbomSha256: sbomArtifact.sha256,
      provenanceSha256: provenanceArtifact.sha256,
    },
    compatibility: {
      protocol: { min: 1, max: 1 },
      creator: process.env.CCP_RELEASE_CREATOR || '>=3.7.0',
      os: (process.env.CCP_RELEASE_OS || 'win32').split(',').filter(Boolean),
      arch: (process.env.CCP_RELEASE_ARCH || 'x64').split(',').filter(Boolean),
    },
  };
}

function signTarget(body, keyId, privateKeyBase64Url, publicKeyBase64Url) {
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error('invalid key ID');
  const privateKey = createPrivateKey({ key: decodeBase64UrlStrict(privateKeyBase64Url), format: 'der', type: 'pkcs8' });
  const payloadBytes = Buffer.from(canonicalize(body), 'utf8');
  const message = Buffer.concat([TARGET_PREFIX, payloadBytes]);
  const signatureBytes = sign(null, message, privateKey);
  if (signatureBytes.length !== 64) throw new Error('Ed25519 produced an unexpected signature length');
  if (publicKeyBase64Url) {
    const publicKey = createPublicKey({ key: decodeBase64UrlStrict(publicKeyBase64Url), format: 'der', type: 'spki' });
    if (!verify(null, message, publicKey, signatureBytes)) throw new Error('self-verify failed');
  }
  return { payload: payloadBytes.toString('base64url'), signatures: [{ keyId, signature: signatureBytes.toString('base64url') }] };
}

function main() {
  const zip = readZip(process.argv[2]);
  const body = buildReleaseTargetBody(zip);
  if (Date.parse(body.expiresAt) <= Date.parse(body.issuedAt)) throw new Error('release target must expire after it is issued');
  const signed = signTarget(
    body,
    requiredEnv('CCP_RELEASE_TARGETS_KEY_ID'),
    requiredEnv('CCP_RELEASE_TARGETS_PRIVATE_KEY'),
    process.env.CCP_RELEASE_TARGETS_PUBLIC_KEY,
  );
  const outPath = path.join(projectRoot, 'dist', 'release-target.signed.json');
  fs.writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(JSON.stringify({ outPath, package: `${body.package.name}@${body.package.version}`, ...body.package }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`sign-release failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { buildReleaseTargetBody, canonicalize, decodeBase64UrlStrict, signTarget };
