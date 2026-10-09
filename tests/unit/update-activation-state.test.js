'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { requireDist } = require('../helpers/require-dist');

const { evaluateUpdateHealth } = requireDist('update/health.js');
const { UpdateStateStore } = requireDist('update/state.js');

const digest = (value) => value.repeat(64).slice(0, 64);

function staged(store) {
  store.persistIfMonotonic({
    ...store.load(),
    highestRootVersion: 1,
    highestTargetSequence: 2,
    highestPolicySequence: 3,
    rootPayloadSha256: digest('a'),
    targetPayloadSha256: digest('b'),
    policyPayloadSha256: digest('c'),
    activeTargetPayloadSha256: digest('d'),
    stagedTargetPayloadSha256: digest('b'),
    stagedDescriptorSha256: digest('e'),
    rollbackTargetPayloadSha256: digest('d'),
    activationState: 'staged',
  });
}

describe('recoverable signed update activation', () => {
  it('persists activating only after helper spawn and restores staged after launch failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-update-state-'));
    try {
      const store = new UpdateStateStore(join(root, 'state.json'));
      staged(store);
      store.beginActivationLaunch();
      assert.equal(store.load().activationState, 'activation-launching');
      store.markActivationLaunchFailed();
      assert.equal(store.load().activationState, 'staged');
      store.beginActivationLaunch();
      store.markActivationSpawned();
      assert.equal(store.load().activationState, 'activating');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('recovers pending health and retries backup retirement before final active', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-update-state-'));
    try {
      const store = new UpdateStateStore(join(root, 'state.json'));
      staged(store);
      store.beginActivationLaunch();
      store.markActivationSpawned();
      store.recoverActivation(true);
      assert.equal(store.load().activationState, 'pending-health');
      store.markHealthPassed();
      assert.equal(store.load().activationState, 'retiring-backup');
      assert.throws(() => store.markBackupRetired(true), /still exists/);
      assert.equal(store.recoverActivation(true).activationState, 'retiring-backup');
      store.markBackupRetired(false);
      assert.equal(store.load().activationState, 'active');
      assert.equal(store.load().activeTargetPayloadSha256, digest('b'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('signed update startup health', () => {
  it('requires UTCP, ACTIVE relay, compatibility, and a passing bounded protected probe', async () => {
    let probes = 0;
    const base = {
      utcpReady: true,
      relayState: 'ACTIVE',
      identityCompatible: true,
      packageCompatible: true,
      creatorCompatible: true,
      protectedProbeTimeoutMs: 50,
      protectedProbe: async () => { probes += 1; return true; },
    };
    assert.equal((await evaluateUpdateHealth(base)).healthy, true);
    assert.equal(probes, 1);
    const locked = await evaluateUpdateHealth({ ...base, relayState: 'LOCKED' });
    assert.deepEqual(locked.failures, ['relay-not-active']);
    assert.equal(probes, 1);
    const incompatible = await evaluateUpdateHealth({ ...base, creatorCompatible: false });
    assert.deepEqual(incompatible.failures, ['creator-incompatible']);
    const denied = await evaluateUpdateHealth({ ...base, protectedProbe: async () => false });
    assert.deepEqual(denied.failures, ['protected-probe-failed']);
  });
});
