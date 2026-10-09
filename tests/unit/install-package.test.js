'use strict';
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ZipArchive } = require('archiver');

const tempPaths = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) fs.rmSync(tempPath, { recursive: true, force: true });
});

async function createBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-package-install-'));
  tempPaths.push(root);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const files = new Map([
    ['ccp3x/package.json', Buffer.from('{"name":"ccp3x","version":"2.0.0-dev.fixture"}')],
    ['ccp3x/dist/main.js', Buffer.from('module.exports = "release-bundle";')],
  ]);
  const manifest = {
    schemaVersion: 1,
    package: 'ccp3x',
    version: '2.0.0-dev.fixture',
    files: [...files].map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: digest(bytes), mode: 0o644 })),
  };
  const manifestPath = path.join(root, 'package-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const zipPath = path.join(root, 'ccp3x.zip');
  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const closed = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });
  archive.pipe(output);
  for (const [entryPath, bytes] of files) archive.append(bytes, { name: entryPath });
  await archive.finalize();
  await closed;
  return { root, project, zipPath, manifestPath };
}

function install(bundle, replace = false) {
  const args = [
    path.join(__dirname, '..', '..', 'scripts', 'install-package.js'),
    '--zip', bundle.zipPath, '--project', bundle.project, '--manifest', bundle.manifestPath,
  ];
  if (replace) args.push('--replace');
  return spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
}

describe('release ZIP project installer', () => {

  it('installs the manifest-verified ZIP as a real project extension directory', async () => {
    const bundle = await createBundle();
    const result = install(bundle);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const destination = path.join(bundle.project, 'extensions', 'ccp3x');
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(destination, 'dist', 'main.js'), 'utf8'), 'module.exports = "release-bundle";');
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'installed');
    assert.equal(output.version, '2.0.0-dev.fixture');
  });

  it('refuses implicit replacement and preserves an explicit backup', async () => {
    const bundle = await createBundle();
    const destination = path.join(bundle.project, 'extensions', 'ccp3x');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'old.txt'), 'old');
    const refused = install(bundle);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /already exists:[\s\S]*-Replace/i);
    assert.equal(fs.readFileSync(path.join(destination, 'old.txt'), 'utf8'), 'old');
    const replaced = install(bundle, true);
    assert.equal(replaced.status, 0, replaced.stderr || replaced.stdout);
    const output = JSON.parse(replaced.stdout.trim());
    assert.match(output.backup, /\.imported-backup-\d+$/);
    assert.equal(fs.readFileSync(path.join(output.backup, 'old.txt'), 'utf8'), 'old');
  });

  it('rejects a ZIP whose bytes do not match the package manifest', async () => {
    const bundle = await createBundle();
    const manifest = JSON.parse(fs.readFileSync(bundle.manifestPath, 'utf8'));
    manifest.files.find((entry) => entry.path.endsWith('/dist/main.js')).sha256 = '0'.repeat(64);
    fs.writeFileSync(bundle.manifestPath, `${JSON.stringify(manifest)}\n`);
    const result = install(bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /digest mismatch/i);
    assert.equal(fs.existsSync(path.join(bundle.project, 'extensions', 'ccp3x')), false);
  });
});
