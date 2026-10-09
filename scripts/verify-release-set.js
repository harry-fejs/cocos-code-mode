'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { canonicalize } = require('./sign-release');

const root = path.resolve(process.env.CCP_RELEASE_DIRECTORY || path.join(__dirname, '..', 'release-set'));
const origin = process.env.CCP_RELEASE_ORIGIN;
const paths = ['release.zip', 'package-manifest.json', 'sbom.cdx.json', 'provenance.intoto.json'];
function fail(message) { throw new Error(message); }
function read(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`missing release artifact: ${relative}`);
  return fs.readFileSync(file);
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function wrapper(relative) {
  let value;
  try { value = JSON.parse(read(relative).toString('utf8')); } catch { fail(`${relative} is not valid JSON`); }
  if (!value || typeof value.payload !== 'string' || !Array.isArray(value.signatures) || value.signatures.length < 1) fail(`${relative} is not a signed metadata wrapper`);
  return value;
}
function payload(wrapperValue, relative) {
  const bytes = Buffer.from(wrapperValue.payload, 'base64url');
  if (!bytes.length) fail(`${relative} payload is empty`);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(`${relative} payload is not JSON`); }
  if (Buffer.from(canonicalize(value)).compare(bytes) !== 0) fail(`${relative} payload is not canonical JSON`);
  return { bytes, value };
}
function main() {
  if (!origin || !origin.startsWith('https://')) fail('CCP_RELEASE_ORIGIN must be an HTTPS origin');
  const target = payload(wrapper('metadata/target.json'), 'target metadata');
  const policy = payload(wrapper('metadata/policy.json'), 'policy metadata');
  const rootMetadata = wrapper('metadata/root.json');
  const targetPackage = target.value.package;
  if (!targetPackage || targetPackage.name !== 'ccp3x') fail('target package identity is invalid');
  const expectedUrls = new Map([
    ['release.zip', targetPackage.url],
    ['package-manifest.json', new URL('package-manifest.json', origin).toString()],
    ['sbom.cdx.json', new URL('sbom.cdx.json', origin).toString()],
    ['provenance.intoto.json', new URL('provenance.intoto.json', origin).toString()],
  ]);
  for (const [name, url] of expectedUrls) {
    if (!url.startsWith(origin)) fail(`${name} escapes the configured release origin`);
  }
  const artifactHashes = Object.fromEntries(paths.map((relative) => [relative, sha(read(relative))]));
  if (artifactHashes['release.zip'] !== targetPackage.sha256) fail('release.zip hash does not match target metadata');
  if (artifactHashes['package-manifest.json'] !== targetPackage.packageManifestSha256) fail('package manifest hash does not match target metadata');
  if (artifactHashes['sbom.cdx.json'] !== targetPackage.sbomSha256) fail('SBOM hash does not match target metadata');
  if (artifactHashes['provenance.intoto.json'] !== targetPackage.provenanceSha256) fail('provenance hash does not match target metadata');
  if (policy.value.targetPayloadSha256 !== sha(target.bytes)) fail('policy target payload hash does not match target metadata');
  const result = { rootSignatures: rootMetadata.signatures.length, packageVersion: targetPackage.version, targetPayloadSha256: sha(target.bytes), policySequence: policy.value.policySequence, artifactHashes };
  console.log(JSON.stringify(result, null, 2));
}
try { main(); } catch (error) { console.error(`verify-release-set failed: ${error.message}`); process.exitCode = 1; }
