'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createWriteStream, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ZipArchive } = require('archiver');
const { requireDist } = require('../helpers/require-dist');

const { extractVerifiedPackage, stageVerifiedReleaseSet } = requireDist('update/stager.js');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function zip(filePath, files) {
  const output = createWriteStream(filePath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const closed = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });
  archive.pipe(output);
  for (const [name, content] of files) archive.append(content, { name, date: new Date('1980-01-01T00:00:00.000Z'), mode: 0o644 });
  await archive.finalize();
  await closed;
}

function manifest(files) {
  return {
    schemaVersion: 1,
    package: 'ccp3x',
    version: '2.1.0',
    files: files.map(([path, bytes]) => ({ path, size: bytes.length, sha256: digest(bytes), mode: 0o644 })),
  };
}

describe('bounded ZIP extraction', () => {
  it('extracts exactly the signed manifest and writes a staged descriptor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-zip-'));
    try {
      const files = [
        ['ccp3x/package.json', Buffer.from('{"name":"ccp3x"}')],
        ['ccp3x/dist/main.js', Buffer.from('module.exports = 1;')],
      ];
      const zipPath = join(root, 'release.zip');
      await zip(zipPath, files);
      const body = Buffer.from(`${JSON.stringify(manifest(files), null, 2)}\n`);
      const sbom = Buffer.from('{"bomFormat":"CycloneDX"}\n');
      const provenance = Buffer.from('{"_type":"https://in-toto.io/Statement/v1"}\n');
      const manifestPath = join(root, 'manifest.json');
      const sbomPath = join(root, 'sbom.json');
      const provenancePath = join(root, 'provenance.json');
      require('node:fs').writeFileSync(manifestPath, body);
      require('node:fs').writeFileSync(sbomPath, sbom);
      require('node:fs').writeFileSync(provenancePath, provenance);
      const zipBytes = readFileSync(zipPath);
      const destination = join(root, 'staged');
      const result = stageVerifiedReleaseSet(zipPath, manifestPath, sbomPath, provenancePath, destination, {
        packageSha256: digest(zipBytes), packageBytes: zipBytes.length,
        packageManifestSha256: digest(body), sbomSha256: digest(sbom), provenanceSha256: digest(provenance),
        targetPayloadSha256: 'a'.repeat(64), policyPayloadSha256: 'b'.repeat(64),
        rootMetadataSha256: 'c'.repeat(64), targetMetadataSha256: 'd'.repeat(64), policyMetadataSha256: 'e'.repeat(64),
      });
      assert.equal(result.directory, join(destination, 'ccp3x'));
      assert.equal(readFileSync(join(result.directory, 'dist', 'main.js'), 'utf8'), 'module.exports = 1;');
      assert.equal(JSON.parse(readFileSync(join(result.directory, '.ccp-staged.json'), 'utf8')).targetPayloadSha256, 'a'.repeat(64));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects undeclared and case-colliding ZIP entries without leaving staging output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-zip-'));
    try {
      const files = [
        ['ccp3x/dist/main.js', Buffer.from('one')],
        ['ccp3x/dist/MAIN.js', Buffer.from('two')],
      ];
      const zipPath = join(root, 'release.zip');
      await zip(zipPath, files);
      const destination = join(root, 'staged');
      assert.throws(() => extractVerifiedPackage(zipPath, manifest(files), destination), /case-colliding/);
      assert.equal(require('node:fs').existsSync(destination), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects tampered entry bytes against the signed manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-zip-'));
    try {
      const actual = [['ccp3x/dist/main.js', Buffer.from('tampered')]];
      const declared = [['ccp3x/dist/main.js', Buffer.from('expected')]];
      const zipPath = join(root, 'release.zip');
      await zip(zipPath, actual);
      assert.throws(() => extractVerifiedPackage(zipPath, manifest(declared), join(root, 'staged')), /does not match/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
