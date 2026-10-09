import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from 'node:path';
import { getWorktreeSlug, resolveGraphOutName } from '../src/output-path.mjs';

describe('cocos-graph output path', () => {
  it('nests isolated worktree data below one .cocos-graph root', () => {
    const out = resolveGraphOutName({
      isolate: true,
      cwd: 'G:/_ws/_helpers/cc-code-mode-cst-merge',
      env: {},
      branch: 'feat/CCP3X Consolidated',
    });
    assert.equal(normalize(out), normalize('.cocos-graph/feat-ccp3x-consolidated'));
  });

  it('uses the same nested layout when isolation comes from the environment', () => {
    const out = resolveGraphOutName({
      cwd: 'G:/_ws/_helpers/cc-code-mode-cst-merge',
      env: { CC_GRAPH_ISOLATE: '1', CC_GRAPH_SLUG: 'Agent A' },
    });
    assert.equal(normalize(out), normalize('.cocos-graph/agent-a'));
  });

  it('keeps explicit CLI and environment output overrides authoritative', () => {
    assert.equal(resolveGraphOutName({ explicitOut: 'custom/cli', isolate: true, env: { CC_GRAPH_OUT: 'custom/env' } }), 'custom/cli');
    assert.equal(resolveGraphOutName({ isolate: true, env: { CC_GRAPH_OUT: 'custom/env' } }), 'custom/env');
  });

  it('falls back to a safe worktree slug for detached HEAD', () => {
    assert.equal(getWorktreeSlug({ cwd: 'G:/worktrees/Review Copy', env: {}, branch: 'HEAD' }), 'review-copy');
  });
});
