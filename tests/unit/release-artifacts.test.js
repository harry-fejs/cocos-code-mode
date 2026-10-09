'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assignArchivePaths, collectPackageEntries, createPackageManifest } = require('../../scripts/release-inventory');
const { createSbom, createProvenance, writeCanonicalJson } = require('../../scripts/release-artifacts');
const { signTarget, decodeBase64UrlStrict } = require('../../scripts/sign-release');
const { rollbackTargets } = require('../../scripts/sign-policy');
const { generateKeyPairSync } = require('node:crypto');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-release-'));
  for (const directory of ['@types', 'dist', 'i18n', 'static', 'scripts', 'node_modules/prod', 'node_modules/dev']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, '@types', 'schema.json'), '{}');
  fs.writeFileSync(path.join(root, 'dist', 'main.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(root, 'dist', 'main.js.map'), 'forbidden');
  fs.writeFileSync(path.join(root, 'dist', 'package-manifest.json'), 'stale');
  fs.writeFileSync(path.join(root, 'dist', 'build-info.json'), JSON.stringify({ commit: 'abc1234', branch: 'main', dirty: false, builtAt: '2026-09-06T00:00:00.000Z' }));
  fs.writeFileSync(path.join(root, 'i18n', 'en.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(root, 'static', 'index.html'), '<main/>');
  fs.writeFileSync(path.join(root, 'README.md'), 'release fixture');
  fs.writeFileSync(path.join(root, 'scripts', 'install-update.ps1'), 'param()');
  fs.writeFileSync(path.join(root, 'node_modules', 'prod', 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(root, 'node_modules', 'dev', 'index.js'), 'module.exports = 2;');
  const lock = {
    name: 'ccp3x',
    version: '2.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'ccp3x', version: '2.0.0' },
      'node_modules/prod': { name: 'prod', version: '1.2.3', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      'node_modules/dev': { name: 'dev', version: '9.9.9', dev: true },
    },
  };
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ccp3x', version: '2.0.0' }));
  return root;
}
const fixtureInputs = {
  trackedFiles: [
    '@types/schema.json',
    'i18n/en.js',
    'static/index.html',
    'package-lock.json',
    'scripts/install-update.ps1',
  ],
  generatedOutputs: ['dist/main.js', 'dist/build-info.json'],
};


describe('deterministic release inventory', () => {
  it('archives only sorted production entries and emits mode-bearing manifest rows', () => {
    const root = fixture();
    try {
      const entries = collectPackageEntries(root, 'ccp3x', { name: 'ccp3x', version: '2.0.0-dev.abc1234' }, fixtureInputs);
      const paths = entries.map((entry) => entry.archivePath);
      assert.deepEqual(paths, [...paths].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
      assert(paths.includes('ccp3x/node_modules/prod/index.js'));
      assert(paths.includes('ccp3x/scripts/install-update.ps1'));
      assert(!paths.some((value) => value.includes('/node_modules/dev/')));
      assert(!paths.some((value) => value.endsWith('.map') || value.endsWith('/package-manifest.json')));
      const manifest = createPackageManifest('ccp3x', '2.0.0-dev.abc1234', entries);
      assert(manifest.files.every((entry) => entry.mode === 0o644 && /^[0-9a-f]{64}$/.test(entry.sha256)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects case-colliding archive paths independently of host filesystem casing', () => {
    const entries = [{ relativePath: 'static/index.html' }, { relativePath: 'static/INDEX.HTML' }];
    assert.throws(() => assignArchivePaths(entries, 'ccp3x'), /case-colliding/);
  });

  it('rejects relevant untracked static and undeclared dist inputs', () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, 'static', 'injected.js'), 'module.exports = 1;');
      assert.throws(
        () => collectPackageEntries(root, 'ccp3x', { name: 'ccp3x', version: '2.0.0' }, fixtureInputs),
        /untracked packaged input: static\/injected\.js/,
      );
      fs.rmSync(path.join(root, 'static', 'injected.js'));
      fs.writeFileSync(path.join(root, 'dist', 'injected.js'), 'module.exports = 1;');
      assert.throws(
        () => collectPackageEntries(root, 'ccp3x', { name: 'ccp3x', version: '2.0.0' }, fixtureInputs),
        /undeclared generated packaged input: dist\/injected\.js/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release sidecar contracts', () => {
  it('emits a production-only CycloneDX inventory with hexadecimal hashes', () => {
    const root = fixture();
    try {
      const sbom = createSbom(root, 'ccp3x', '2.0.0', 'a'.repeat(64));
      assert.equal(sbom.specVersion, '1.6');
      assert.deepEqual(sbom.components.map((component) => component.name), ['prod']);
      assert.match(sbom.components[0].hashes[0].content, /^[0-9a-f]{128}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds clean source, lockfiles, ZIP, manifest, and SBOM in provenance', () => {
    const root = fixture();
    try {
      const zipPath = path.join(root, 'ccp3x.zip');
      fs.writeFileSync(zipPath, 'zip');
      const manifest = writeCanonicalJson(path.join(root, 'manifest.json'), { files: [] });
      const sbom = writeCanonicalJson(path.join(root, 'sbom.json'), { components: [] });
      const statement = createProvenance(root, zipPath, manifest, sbom);
      assert.equal(statement.predicate.buildDefinition.internalParameters.builtAt, '1980-01-01T00:00:00.000Z');
      assert.equal(statement.predicate.buildDefinition.resolvedDependencies.length, 2);
      assert.equal(statement.predicate.runDetails.byproducts.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('offline target signer primitives', () => {
  it('strictly decodes base64url and self-verifies Ed25519 target signatures', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const body = { schemaVersion: 1, package: { sha256: 'a'.repeat(64) } };
    const signed = signTarget(body, 'targets-test-1', privateDer, publicDer);
    assert.equal(decodeBase64UrlStrict(signed.payload).toString('utf8').includes('schemaVersion'), true);
    assert.equal(signed.signatures[0].signature.length > 80, true);
    assert.throws(() => decodeBase64UrlStrict(`${signed.payload}=`), /unpadded/);
  });
});

describe('rollout policy signer inputs', () => {
  it('accepts only a bounded unique rollback-target allowlist', () => {
    const previous = process.env.CCP_POLICY_ROLLBACK_TARGET_SHA256;
    try {
      process.env.CCP_POLICY_ROLLBACK_TARGET_SHA256 = `${'a'.repeat(64)}, ${'b'.repeat(64)},${'a'.repeat(64)}`;
      assert.deepEqual(rollbackTargets(), ['a'.repeat(64), 'b'.repeat(64)]);
      process.env.CCP_POLICY_ROLLBACK_TARGET_SHA256 = 'not-a-digest';
      assert.throws(() => rollbackTargets(), /at most 8 comma-separated/);
    } finally {
      if (previous === undefined) delete process.env.CCP_POLICY_ROLLBACK_TARGET_SHA256;
      else process.env.CCP_POLICY_ROLLBACK_TARGET_SHA256 = previous;
    }
  });
});
