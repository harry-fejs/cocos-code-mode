import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordVerifiedSession } from '../src/session.mjs';

describe('verified scene session continuity', () => {
  it('rejects unverified work and atomically records verified context', () => {
    const root = mkdtempSync(join(tmpdir(), 'cocos-session-'));
    try {
      assert.throws(() => recordVerifiedSession({ root, project: 'P', bundle: 'B', sceneUuid: 'S', task: 'T', verified: false }), /requires verified=true/);
      const artifact = recordVerifiedSession({ root, project: 'P', bundle: 'B', sceneUuid: 'S', workingPath: '/Canvas', task: 'verified edit', verified: true });
      const stored = JSON.parse(readFileSync(join(root, '.claude', 'ccp-session.json'), 'utf8'));
      assert.deepEqual(stored, artifact);
      assert.equal(stored.verified, true);
      assert.equal(stored.age_ms, 0);
      assert.ok(Number.isFinite(Date.parse(stored.updatedAt)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
