'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { requireDist } = require('../helpers/require-dist');

const { prepareActivation, verifyStagedDirectory } = requireDist('protected/staged-update.js');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function stagedFixture(root) {
  const staged = join(root, 'extracted', 'ccp3x');
  const payloadPath = join(staged, 'dist', 'main.js');
  mkdirSync(join(payloadPath, '..'), { recursive: true });
  const payload = Buffer.from('module.exports = 1;');
  writeFileSync(payloadPath, payload);
  const manifest = {
    schemaVersion: 1, package: 'ccp3x', version: '2.1.0',
    files: [{ path: 'ccp3x/dist/main.js', size: payload.length, sha256: digest(payload), mode: 0o644 }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(staged, '.ccp-package-manifest.json'), manifestBytes);
  const releaseZip = Buffer.from('zip');
  const sbom = Buffer.from('{}\n');
  const provenance = Buffer.from('{}\n');
  const rootMetadata = Buffer.from('{}\n');
  const targetMetadata = Buffer.from('{}\n');
  const policyMetadata = Buffer.from('{}\n');
  for (const [name, bytes] of [
    ['release.zip', releaseZip],
    ['package-manifest.json', manifestBytes],
    ['sbom.cdx.json', sbom],
    ['provenance.intoto.json', provenance],
    ['root.signed.json', rootMetadata],
    ['target.signed.json', targetMetadata],
    ['policy.signed.json', policyMetadata],
  ]) writeFileSync(join(root, name), bytes);
  const descriptor = {
    schemaVersion: 1, packageSha256: digest(releaseZip), packageBytes: releaseZip.length, packageManifestSha256: digest(manifestBytes),
    sbomSha256: digest(sbom), provenanceSha256: digest(provenance),
    targetPayloadSha256: 'b'.repeat(64), policyPayloadSha256: 'c'.repeat(64),
    rootMetadataSha256: digest(rootMetadata), targetMetadataSha256: digest(targetMetadata), policyMetadataSha256: digest(policyMetadata),
    version: '2.1.0',
  };
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor)}\n`);
  writeFileSync(join(staged, '.ccp-staged.json'), descriptorBytes);
  return { staged, payloadPath, descriptorSha256: digest(descriptorBytes) };
}

describe('staged directory activation preflight', () => {
  it('re-verifies the exact extracted manifest and sibling live directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-staged-'));
    try {
      const fixture = stagedFixture(root);
      const live = join(root, 'live');
      mkdirSync(live);
      const verified = prepareActivation(1234, fixture.staged, live, fixture.descriptorSha256);
      assert.equal(verified.version, '2.1.0');
      assert.equal(verified.creatorPid, 1234);
      assert.equal(verified.liveDirectory, live);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects descriptor and staged-file tampering before any swap', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-staged-'));
    try {
      const fixture = stagedFixture(root);
      assert.throws(() => verifyStagedDirectory(fixture.staged, 'f'.repeat(64)), /descriptor digest/);
      writeFileSync(fixture.payloadPath, Buffer.from('tampered'));
      assert.throws(() => verifyStagedDirectory(fixture.staged, fixture.descriptorSha256), /does not match/);
      assert.equal(readFileSync(fixture.payloadPath, 'utf8'), 'tampered');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
