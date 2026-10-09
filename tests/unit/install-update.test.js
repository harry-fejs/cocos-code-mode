'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('Windows signed update activation helper', { skip: process.platform !== 'win32' }, () => {
  it('waits for the exact process, re-verifies the immutable set, swaps, and retains one backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-activate-'));
    const staged = join(root, 'extracted', 'ccp3x');
    const live = join(root, 'live');
    try {
      mkdirSync(join(staged, 'dist'), { recursive: true });
      mkdirSync(live);
      writeFileSync(join(live, 'old.txt'), 'old');
      const payload = Buffer.from('module.exports = "new";');
      writeFileSync(join(staged, 'dist', 'main.js'), payload);
      const manifest = {
        schemaVersion: 1, package: 'ccp3x', version: '2.1.0',
        files: [{ path: 'ccp3x/dist/main.js', size: payload.length, sha256: digest(payload), mode: 0o644 }],
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      writeFileSync(join(staged, '.ccp-package-manifest.json'), manifestBytes);
      const artifacts = {
        'release.zip': Buffer.from('zip'),
        'package-manifest.json': manifestBytes,
        'sbom.cdx.json': Buffer.from('{}\n'),
        'provenance.intoto.json': Buffer.from('{}\n'),
        'root.signed.json': Buffer.from('{}\n'),
        'target.signed.json': Buffer.from('{}\n'),
        'policy.signed.json': Buffer.from('{}\n'),
      };
      for (const [name, bytes] of Object.entries(artifacts)) writeFileSync(join(root, name), bytes);
      const descriptor = {
        schemaVersion: 1,
        packageSha256: digest(artifacts['release.zip']), packageBytes: artifacts['release.zip'].length,
        packageManifestSha256: digest(manifestBytes), sbomSha256: digest(artifacts['sbom.cdx.json']),
        provenanceSha256: digest(artifacts['provenance.intoto.json']),
        targetPayloadSha256: 'a'.repeat(64), policyPayloadSha256: 'b'.repeat(64),
        rootMetadataSha256: digest(artifacts['root.signed.json']), targetMetadataSha256: digest(artifacts['target.signed.json']),
        policyMetadataSha256: digest(artifacts['policy.signed.json']), version: '2.1.0',
      };
      const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor)}\n`);
      writeFileSync(join(staged, '.ccp-staged.json'), descriptorBytes);
      const creator = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore', windowsHide: true });
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, '..', '..', 'scripts', 'install-update.ps1'),
        '-CreatorPid', String(creator.pid), '-CreatorExecutablePath', process.execPath,
        '-StagedDirectory', staged, '-LiveDirectory', live, '-DescriptorSha256', digest(descriptorBytes),
      ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(readFileSync(join(live, 'dist', 'main.js'), 'utf8'), payload.toString());
      assert.equal(readFileSync(join(root, 'live.prev', 'old.txt'), 'utf8'), 'old');
      assert.match(result.stdout, /state=pending-health version=2\.1\.0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores exactly one retained package after failed startup health', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-rollback-'));
    const live = join(root, 'live');
    const backup = join(root, 'live.prev');
    try {
      mkdirSync(live);
      mkdirSync(backup);
      writeFileSync(join(live, 'version.txt'), 'failed');
      writeFileSync(join(backup, 'version.txt'), 'previous');
      const creator = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore', windowsHide: true });
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, '..', '..', 'scripts', 'install-update.ps1'),
        '-CreatorPid', String(creator.pid), '-CreatorExecutablePath', process.execPath,
        '-LiveDirectory', live, '-RollbackPendingHealth',
      ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(readFileSync(join(live, 'version.txt'), 'utf8'), 'previous');
      assert.match(result.stdout, /state=rolled-back/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
