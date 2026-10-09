'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { requireDist } = require('../helpers/require-dist');

const { acceptRelease, acceptRootRotation } = requireDist('update/trust.js');
const { satisfiesSemverRange } = requireDist('update/semver-range.js');
const { UpdateStateStore } = requireDist('update/state.js');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function key(id) {
  const pair = generateKeyPairSync('ed25519');
  return {
    id,
    privateKey: pair.privateKey,
    spkiDer: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  };
}

function signed(kind, body, signer, additionalSigners = []) {
  const payload = Buffer.from(canonicalize(body), 'utf8');
  const prefix = Buffer.from(kind === 'root'
    ? 'CCP1 release-root\n'
    : kind === 'target'
      ? 'CCP1 release-targets\n'
      : 'CCP1 rollout-policy\n');
  return {
    payload: payload.toString('base64url'),
    signatures: [signer, ...additionalSigners].map((entry) => ({
      keyId: entry.id,
      signature: sign(null, Buffer.concat([prefix, payload]), entry.privateKey).toString('base64url'),
    })),
  };
}

function fixture(nowMs) {
  const rootKey = key('root-key-1');
  const targetKey = key('target-key-1');
  const policyKey = key('policy-key-1');
  const iso = (offset) => new Date(nowMs + offset).toISOString();
  const root = {
    schemaVersion: 1,
    product: 'ccp3x',
    rootVersion: 1,
    issuedAt: iso(-60_000),
    expiresAt: iso(86_400_000),
    keys: {
      [rootKey.id]: { algorithm: 'Ed25519', spkiDer: rootKey.spkiDer },
      [targetKey.id]: { algorithm: 'Ed25519', spkiDer: targetKey.spkiDer },
      [policyKey.id]: { algorithm: 'Ed25519', spkiDer: policyKey.spkiDer },
    },
    roles: {
      root: { keyIds: [rootKey.id], threshold: 1 },
      targets: { keyIds: [targetKey.id], threshold: 1 },
      policy: { keyIds: [policyKey.id], threshold: 1 },
    },
  };
  const target = {
    schemaVersion: 1,
    metadataVersion: 1,
    releaseSequence: 7,
    issuedAt: iso(-30_000),
    expiresAt: iso(3_600_000),
    package: {
      name: 'ccp3x', version: '2.1.0', sha256: 'a'.repeat(64), size: 123,
      url: 'https://releases.example.test/ccp3x.zip',
      packageManifestSha256: 'b'.repeat(64), sbomSha256: 'c'.repeat(64), provenanceSha256: 'd'.repeat(64),
    },
    compatibility: { protocol: { min: 1, max: 1 }, creator: '>=3.7.0', os: ['win32'], arch: ['x64'] },
  };
  const targetWrapper = signed('target', target, targetKey);
  const targetPayloadSha256 = createHash('sha256').update(Buffer.from(targetWrapper.payload, 'base64url')).digest('hex');
  const policy = {
    schemaVersion: 1, policySequence: 9, issuedAt: iso(-20_000), expiresAt: iso(300_000),
    targetPayloadSha256, channel: 'stable', ring: '10', percentage: 100, recommended: true,
    blockedBuilds: [], rollbackTargetPayloadSha256: [], disabledOperations: [], emergencyStop: false,
  };
  return { root, rootKey, targetWrapper, target, targetKey, policyWrapper: signed('policy', policy, policyKey), policy, policyKey };
}

describe('signed update trust transaction', () => {
  const nowMs = Date.parse('2026-09-06T12:00:00.000Z');
  const compatibility = {
    protocolVersion: 1, creatorVersion: '3.8.7', os: 'win32', arch: 'x64', currentBuild: '2.0.0',
    deviceId: 'device-test-1', channel: 'stable', allowedRing: '10',
  };

  it('accepts bound target/policy bytes and persists monotonic digests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccp-update-trust-'));
    try {
      const data = fixture(nowMs);
      const store = new UpdateStateStore(join(dir, 'state.json'));
      const accepted = acceptRelease(data.root, data.targetWrapper, data.policyWrapper, compatibility, store, nowMs);
      assert.equal(accepted.target.package.version, '2.1.0');
      assert.equal(store.load().highestPolicySequence, 9);
      assert.equal(store.load().targetPayloadSha256, data.policy.targetPayloadSha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('binds the installed signed target before the first update so health rollback is permitted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccp-update-trust-'));
    try {
      const data = fixture(nowMs);
      const installedTarget = 'e'.repeat(64);
      const policy = { ...data.policy, rollbackTargetPayloadSha256: [installedTarget] };
      const store = new UpdateStateStore(join(dir, 'state.json'));
      store.initializeInstalledTarget(installedTarget);
      acceptRelease(data.root, data.targetWrapper, signed('policy', policy, data.policyKey), compatibility, store, nowMs);
      assert.equal(store.load().activeTargetPayloadSha256, installedTarget);
      assert.equal(store.load().rollbackTargetPayloadSha256, installedTarget);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects mix-and-match target bytes and same-sequence different policy bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccp-update-trust-'));
    try {
      const data = fixture(nowMs);
      const store = new UpdateStateStore(join(dir, 'state.json'));
      acceptRelease(data.root, data.targetWrapper, data.policyWrapper, compatibility, store, nowMs);
      const changed = { ...data.policy, recommended: false };
      const changedWrapper = signed('policy', changed, data.policyKey);
      assert.throws(() => acceptRelease(data.root, data.targetWrapper, changedWrapper, compatibility, store, nowMs), /different signed bytes/);
      const mismatched = { ...data.policy, policySequence: 10, targetPayloadSha256: 'f'.repeat(64) };
      assert.throws(() => acceptRelease(data.root, data.targetWrapper, signed('policy', mismatched, data.policyKey), compatibility, store, nowMs), /different signed target bytes/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists a verified emergency policy high-water before denying execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccp-update-trust-'));
    try {
      const data = fixture(nowMs);
      const store = new UpdateStateStore(join(dir, 'state.json'));
      const stopped = { ...data.policy, policySequence: data.policy.policySequence + 1, emergencyStop: true };
      assert.throws(() => acceptRelease(data.root, data.targetWrapper, signed('policy', stopped, data.policyKey), compatibility, store, nowMs), /emergency stop/);
      assert.equal(store.load().highestPolicySequence, stopped.policySequence);
      assert.throws(() => acceptRelease(data.root, data.targetWrapper, data.policyWrapper, compatibility, store, nowMs), /rolled back/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('enforces full Creator SemVer ranges including upper bounds, ORs, and prereleases', () => {
    assert.equal(satisfiesSemverRange('3.8.7', '>=3.7.0 <3.9.0'), true);
    assert.equal(satisfiesSemverRange('3.9.0', '>=3.7.0 <3.9.0'), false);
    assert.equal(satisfiesSemverRange('3.8.7', '^3.7.0 || ~4.1.0'), true);
    assert.equal(satisfiesSemverRange('3.8.0-beta.1', '>=3.8.0'), false);
    assert.equal(satisfiesSemverRange('3.8.0-beta.1', '>=3.8.0-beta.1 <3.8.0'), true);
  });

  it('accepts root rotation only when current and candidate thresholds are independently met', () => {
    const data = fixture(nowMs);
    const nextRootKey = key('root-key-2');
    const candidate = {
      ...data.root,
      rootVersion: 2,
      keys: {
        ...data.root.keys,
        [nextRootKey.id]: { algorithm: 'Ed25519', spkiDer: nextRootKey.spkiDer },
      },
      roles: {
        ...data.root.roles,
        root: { keyIds: [nextRootKey.id], threshold: 1 },
      },
    };
    assert.equal(acceptRootRotation(data.root, signed('root', candidate, data.rootKey, [nextRootKey]), nowMs).rootVersion, 2);
    assert.throws(() => acceptRootRotation(data.root, signed('root', candidate, data.rootKey), nowMs), /candidate-root signature threshold/);
    assert.throws(() => acceptRootRotation(data.root, signed('root', candidate, nextRootKey), nowMs), /current-root signature threshold/);
    const duplicate = signed('root', candidate, data.rootKey, [nextRootKey]);
    duplicate.signatures.push(duplicate.signatures[0]);
    assert.throws(() => acceptRootRotation(data.root, duplicate, nowMs), /duplicate signature/);
  });
});
