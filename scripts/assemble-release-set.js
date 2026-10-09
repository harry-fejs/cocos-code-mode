'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const projectRoot = path.join(__dirname, '..');
const outputRoot = path.resolve(process.env.CCP_RELEASE_DIRECTORY || path.join(projectRoot, 'release-set'));
const rootMetadataPath = process.env.CCP_RELEASE_ROOT_METADATA_PATH;
const releaseZip = path.resolve(process.argv[2] || process.env.CCP_RELEASE_ZIP || '');

const files = [
  ['target', path.join(projectRoot, 'dist', 'release-target.signed.json')],
  ['policy', path.join(projectRoot, 'dist', 'rollout-policy.signed.json')],
  ['package-manifest.json', path.join(projectRoot, 'dist', 'package-manifest.json')],
  ['sbom.cdx.json', path.join(projectRoot, 'dist', 'sbom.cdx.json')],
  ['provenance.intoto.json', path.join(projectRoot, 'dist', 'provenance.intoto.json')],
];

function fail(message) { throw new Error(message); }
function regular(file, label) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`${label} must be a regular file`);
  return fs.readFileSync(file);
}
function signedWrapper(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(`${label} must be valid JSON`); }
  if (!value || typeof value.payload !== 'string' || !Array.isArray(value.signatures) || value.signatures.length < 1) {
    fail(`${label} must be a signed metadata wrapper`);
  }
}
function writeExclusive(relative, bytes) {
  const destination = path.join(outputRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  return { path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function main() {
  if (!rootMetadataPath) fail('CCP_RELEASE_ROOT_METADATA_PATH is required');
  const sources = [
    ['metadata/root.json', path.resolve(rootMetadataPath), 'signed root metadata'],
    ['metadata/target.json', files[0][1], 'signed target metadata'],
    ['metadata/policy.json', files[1][1], 'signed policy metadata'],
    ['release.zip', releaseZip, 'release ZIP'],
    ...files.slice(2).map(([relative, source]) => [relative, source, relative]),
  ];
  const prepared = sources.map(([relative, source, label]) => ({ relative, bytes: regular(source, label), label }));
  for (const item of prepared.slice(0, 3)) signedWrapper(item.bytes, item.label);
  if (fs.existsSync(outputRoot)) {
    if (!fs.statSync(outputRoot).isDirectory()) fail('CCP_RELEASE_DIRECTORY must be a directory');
    if (fs.readdirSync(outputRoot).length > 0) fail('CCP_RELEASE_DIRECTORY must be empty for an immutable assembly');
  }
  const artifacts = prepared.map(({ relative, bytes }) => writeExclusive(relative, bytes));
  console.log(JSON.stringify({ outputRoot, artifacts }, null, 2));
}

try { main(); } catch (error) { console.error(`assemble-release-set failed: ${error.message}`); process.exitCode = 1; }
