'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Require the bootstrap module for its exported pure core.
// Do not trigger main() — it only runs when require.main === module.
const bootstrap = require(path.join(__dirname, '..', '..', 'scripts', 'ccp-bootstrap.js'));
const { buildCache, isLiveProbe, computeAgeMs } = bootstrap;

// ── helpers ────────────────────────────────────────────────────────────────

function makePriorEntry(overrides = {}) {
  const now = new Date();
  return {
    url: 'http://localhost:11111/utcp',
    toolCount: 42,
    tools: Array.from({ length: 42 }, (_, i) => `tool_${i}`),
    toolDefs: Array.from({ length: 42 }, (_, i) => ({ name: `tool_${i}` })),
    buildInfo: { version: '2.0.0', commit: 'abc123', branch: 'main', dirty: false, builtAt: now.toISOString() },
    fetchedAt: now.toISOString(),
    age_ms: 0,
    live: true,
    authoritative: true,
    stale: false,
    ...overrides,
  };
}

function utcpConfigFor(entries) {
  // entries: [{ name, port }]
  return {
    manual_call_templates: entries.map(({ name, port }) => ({
      name,
      call_template_type: 'http',
      url: `http://localhost:${port}/utcp`,
      http_method: 'GET',
      content_type: 'application/json',
    })),
  };
}

function mockFetch(map) {
  // map: { url: value }  value may be object, null, or fn(url)->value
  return async (url) => {
    if (typeof map[url] === 'function') return map[url](url);
    if (url in map) return map[url];
    return null;
  };
}

const LIVE_MANUAL = { utcp_version: '1.0.1', manual_version: '1.0.0', tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
const LIVE_BUILD = { version: '2.0.0', commit: 'deadbeef', branch: 'cc-3x7', dirty: false, builtAt: new Date().toISOString() };
const DEAD_MANUAL_EMPTY = { utcp_version: '1.0.1', manual_version: '1.0.0', tools: [] };

describe('bootstrap handshake evidence', () => {
  it('distinguishes responsive not-ready, timeout, malformed response and old builds without poisoning discovery', async () => {
    const config = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const payload = { instanceId: 'instance', probe: { status: 'responsive', sceneReady: false, code: null } };
    for (const [response, status] of [
      [payload, 'responsive'],
      [{ ok: true, tool: 'editorHandshake', data: payload }, 'responsive'],
      [{ instanceId: 'instance', probe: { status: 'timeout', sceneReady: null } }, 'timeout'],
      [{ instanceId: 'instance', probe: { status: 'responsive', sceneReady: 'false' } }, 'unverified'],
      [null, 'unverified'],
    ]) {
      const cache = await buildCache({ utcpConfig: config, priorCache: null, now: new Date(), fetchJson: mockFetch({
        'http://localhost:11111/utcp': { ...LIVE_MANUAL, tools: [{ name: 'editorHandshake' }] },
        'http://localhost:11111/build-info': LIVE_BUILD,
        'http://localhost:11111/tools/editorHandshake?timeoutMs=1000': response,
      }) });
      assert.equal(cache.manuals.ccp3x_11111.handshake.status, status);
      assert.equal(cache.manuals.ccp3x_11111.live, true, 'manual discovery is independent of IPC readiness');
      if (status === 'responsive') assert.equal(cache.manuals.ccp3x_11111.handshake.result.probe.sceneReady, false);
    }
    const old = await buildCache({ utcpConfig: config, priorCache: null, now: new Date(), fetchJson: mockFetch({
      'http://localhost:11111/utcp': LIVE_MANUAL, 'http://localhost:11111/build-info': LIVE_BUILD,
    }) });
    assert.equal(old.manuals.ccp3x_11111.handshake.status, 'unsupported');
  });

  it('never reuses cached handshake success after failed or omitted probes', async () => {
    const priorCache = { manuals: { ccp3x: makePriorEntry({ handshake: { status: 'responsive', result: { instanceId: 'old' } } }) } };
    for (const entries of [[{ name: 'ccp3x', port: 11111 }], []]) {
      const cache = await buildCache({ utcpConfig: utcpConfigFor(entries), priorCache, now: new Date(), fetchJson: async () => null });
      assert.notEqual(cache.manuals.ccp3x_11111.handshake.status, 'responsive');
      assert.equal(cache.manuals.ccp3x_11111.handshake.result, null);
      assert.equal(cache.manuals.ccp3x_11111.toolCount, 42);
    }
  });
});

// ── isLiveProbe unit ─────────────────────────────────────────────────────

describe('ccp-bootstrap — isLiveProbe liveness gate', () => {
  it('live when fetch succeeded, toolCount>0, provenance present', () => {
    assert.equal(isLiveProbe(LIVE_MANUAL, LIVE_BUILD, LIVE_MANUAL.tools.length), true);
  });

  it('dead when toolCount is 0 even with provenance', () => {
    assert.equal(isLiveProbe(DEAD_MANUAL_EMPTY, LIVE_BUILD, 0), false);
  });

  it('dead when fetch returned null (editor unreachable)', () => {
    assert.equal(isLiveProbe(null, null, 0), false);
    assert.equal(isLiveProbe(null, LIVE_BUILD, 0), false);
  });

  it('dead when tools is not an array', () => {
    assert.equal(isLiveProbe({ utcp_version: '1.0.1' }, LIVE_BUILD, 0), false);
    assert.equal(isLiveProbe({}, LIVE_BUILD, 5), false);
  });

  it('dead when provenance absent despite toolCount>0', () => {
    // No manual_version/utcp_version and no buildInfo — treated as dead per spec
    const noProv = { tools: [{ name: 'a' }] };
    assert.equal(isLiveProbe(noProv, null, 1), false);
  });

  it('live with only manual_version and no buildInfo', () => {
    const m = { manual_version: '1.0.0', tools: [{ name: 'a' }] };
    assert.equal(isLiveProbe(m, null, 1), true);
  });

  it('live with only utcp_version and no manual_version', () => {
    const m = { utcp_version: '1.0.1', tools: [{ name: 'a' }] };
    assert.equal(isLiveProbe(m, null, 1), true);
  });

  it('live with only buildInfo and no manual version', () => {
    const m = { tools: [{ name: 'a' }] };
    assert.equal(isLiveProbe(m, LIVE_BUILD, 1), true);
  });
});

describe('ccp-bootstrap — computeAgeMs', () => {
  it('computes age_ms = now - fetchedAt', () => {
    const fetchedAt = new Date('2026-09-03T00:00:00.000Z').toISOString();
    const nowMs = Date.parse('2026-09-03T01:00:00.000Z');
    assert.equal(computeAgeMs(fetchedAt, nowMs), 60 * 60 * 1000);
  });

  it('returns 0 when fetchedAt equals now', () => {
    const iso = new Date('2026-09-03T12:00:00.000Z').toISOString();
    assert.equal(computeAgeMs(iso, Date.parse(iso)), 0);
  });

  it('returns null for missing or invalid fetchedAt', () => {
    assert.equal(computeAgeMs(null, Date.now()), null);
    assert.equal(computeAgeMs(undefined, Date.now()), null);
    assert.equal(computeAgeMs('not-a-date', Date.now()), null);
  });
});

// ── buildCache — the regression suite ────────────────────────────────────

describe('ccp-bootstrap — buildCache probe gate (regression)', () => {
  it('dead-editor fetch never overwrites good cache (retains prior, marks stale)', async () => {
    const prior = { updatedAt: new Date().toISOString(), manuals: { ccp3x: makePriorEntry({ toolCount: 50 }) } };
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const now = new Date();
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: prior,
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': null, // dead: connection refused
        'http://localhost:11111/build-info': null,
      }),
      now,
    });
    // Must retain the good entry, not clobber with 0
    assert.equal(result.manuals.ccp3x_11111.toolCount, 50, 'good entry must be retained');
    assert.equal(result.manuals.ccp3x_11111.authoritative, true);
    assert.equal(result.manuals.ccp3x_11111.live, false);
    assert.equal(result.manuals.ccp3x_11111.stale, true);
    assert.equal(result.manuals.ccp3x_11111.staleReason, 'probe_failed');
    assert.ok(typeof result.manuals.ccp3x_11111.age_ms === 'number' && result.manuals.ccp3x_11111.age_ms >= 0);
  });

  it('dead fetch that returns empty tools array also retains good cache', async () => {
    const prior = { updatedAt: new Date().toISOString(), manuals: { ccp3x: makePriorEntry({ toolCount: 30 }) } };
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: prior,
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': DEAD_MANUAL_EMPTY,
        'http://localhost:11111/build-info': LIVE_BUILD,
      }),
      now: new Date(),
    });
    assert.equal(result.manuals.ccp3x_11111.toolCount, 30);
    assert.equal(result.manuals.ccp3x_11111.stale, true);
    assert.equal(result.manuals.ccp3x_11111.live, false);
  });

  it('first-run dead fetch does not create an authoritative 0 entry (tombstone)', async () => {
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: null, // no prior file — first run
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': null,
        'http://localhost:11111/build-info': null,
      }),
      now: new Date(),
    });
    // The key exists as a tombstone but is NOT authoritative
    assert.ok(result.manuals.ccp3x_11111, 'tombstone should be present for diagnostics');
    assert.equal(result.manuals.ccp3x_11111.toolCount, 0);
    assert.equal(result.manuals.ccp3x_11111.authoritative, false, 'first-run dead fetch must not be authoritative');
    assert.equal(result.manuals.ccp3x_11111.live, false);
    assert.equal(result.manuals.ccp3x_11111.stale, true);
    assert.equal(result.manuals.ccp3x_11111.staleReason, 'probe_failed');
  });

  it('first-run dead fetch with empty-tools response also creates tombstone', async () => {
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: { updatedAt: new Date().toISOString(), manuals: {} }, // empty prior
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': DEAD_MANUAL_EMPTY,
        'http://localhost:11111/build-info': null,
      }),
      now: new Date(),
    });
    assert.equal(result.manuals.ccp3x_11111.authoritative, false);
    assert.equal(result.manuals.ccp3x_11111.toolCount, 0);
  });

  it('live probe writes authoritative entry with age_ms:0 and fetchedAt', async () => {
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const now = new Date('2026-09-03T12:00:00.000Z');
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: null,
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': LIVE_MANUAL,
        'http://localhost:11111/build-info': LIVE_BUILD,
      }),
      now,
    });
    assert.equal(result.manuals.ccp3x_11111.toolCount, 3);
    assert.equal(result.manuals.ccp3x_11111.authoritative, true);
    assert.equal(result.manuals.ccp3x_11111.live, true);
    assert.equal(result.manuals.ccp3x_11111.stale, false);
    assert.equal(result.manuals.ccp3x_11111.age_ms, 0);
    assert.equal(result.manuals.ccp3x_11111.fetchedAt, now.toISOString());
    assert.deepEqual(result.manuals.ccp3x_11111.buildInfo, LIVE_BUILD);
  });

  it('live probe overwrites a stale prior (recovery)', async () => {
    const stalePrior = makePriorEntry({ toolCount: 5, fetchedAt: new Date(Date.now() - 10000).toISOString(), stale: true, live: false, age_ms: 10000 });
    const prior = { updatedAt: new Date().toISOString(), manuals: { ccp3x: stalePrior } };
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const now = new Date();
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: prior,
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': { utcp_version: '1.0.1', manual_version: '1.0.0', tools: [{ name: 'x' }, { name: 'y' }] },
        'http://localhost:11111/build-info': LIVE_BUILD,
      }),
      now,
    });
    assert.equal(result.manuals.ccp3x_11111.toolCount, 2);
    assert.equal(result.manuals.ccp3x_11111.authoritative, true);
    assert.equal(result.manuals.ccp3x_11111.live, true);
    assert.equal(result.manuals.ccp3x_11111.stale, false);
  });

  it('ccp3x and ccp2x are independent — dead ccp3x does not clobber live ccp2x', async () => {
    const prior = {
      updatedAt: new Date().toISOString(),
      manuals: {
        ccp3x: makePriorEntry({ url: 'http://localhost:11111/utcp', toolCount: 50 }),
        ccp2x: makePriorEntry({ url: 'http://localhost:22222/utcp', toolCount: 30 }),
      },
    };
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }, { name: 'ccp2x', port: 22222 }]);
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: prior,
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': null, // ccp3x dead
        'http://localhost:11111/build-info': null,
        'http://localhost:22222/utcp': LIVE_MANUAL, // ccp2x live
        'http://localhost:22222/build-info': LIVE_BUILD,
      }),
      now: new Date(),
    });
    // ccp3x retained
    assert.equal(result.manuals.ccp3x_11111.toolCount, 50);
    assert.equal(result.manuals.ccp3x_11111.live, false);
    assert.equal(result.manuals.ccp3x_11111.stale, true);
    // ccp2x freshly written
    assert.equal(result.manuals.ccp2x_22222.toolCount, 3);
    assert.equal(result.manuals.ccp2x_22222.live, true);
    assert.equal(result.manuals.ccp2x_22222.authoritative, true);
  });

  it('ccp3x live does not resurrect a dead ccp2x tombstone into authoritative', async () => {
    const prior = null;
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }, { name: 'ccp2x', port: 22222 }]);
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: prior,
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': LIVE_MANUAL,
        'http://localhost:11111/build-info': LIVE_BUILD,
        'http://localhost:22222/utcp': null, // ccp2x dead
        'http://localhost:22222/build-info': null,
      }),
      now: new Date(),
    });
    assert.equal(result.manuals.ccp3x_11111.authoritative, true);
    assert.equal(result.manuals.ccp3x_11111.toolCount, 3);
    assert.equal(result.manuals.ccp2x_22222.authoritative, false);
    assert.equal(result.manuals.ccp2x_22222.toolCount, 0);
  });

  it('prior key not probed this run is retained with refreshed age_ms', async () => {
    const fetchedAt = new Date(Date.now() - 5000).toISOString();
    const prior = {
      updatedAt: new Date().toISOString(),
      manuals: { ccp2x: makePriorEntry({ url: 'http://localhost:22222/utcp', toolCount: 30, fetchedAt, age_ms: 0 }) },
    };
    // This run only has ccp3x in the config; ccp2x absent
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const now = new Date();
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: prior,
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': LIVE_MANUAL,
        'http://localhost:11111/build-info': LIVE_BUILD,
      }),
      now,
    });
    assert.ok(result.manuals.ccp2x_22222, 'unprobed prior key must be retained');
    assert.equal(result.manuals.ccp2x_22222.toolCount, 30);
    assert.ok(result.manuals.ccp2x_22222.age_ms >= 4000, `age_ms should reflect ~5s elapsed, got ${result.manuals.ccp2x_22222.age_ms}`);
  });

  it('max-age: prior older than 24h without successful probe is marked stale (max_age)', async () => {
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const prior = {
      updatedAt: longAgo,
      manuals: { ccp3x: makePriorEntry({ toolCount: 50, fetchedAt: longAgo, age_ms: 0, stale: false, live: true }) },
    };
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: prior,
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': null, // still dead
        'http://localhost:11111/build-info': null,
      }),
      now: new Date(),
    });
    assert.equal(result.manuals.ccp3x_11111.toolCount, 50, 'count must be retained');
    assert.equal(result.manuals.ccp3x_11111.stale, true);
    assert.equal(result.manuals.ccp3x_11111.staleReason, 'max_age');
  });

  it('legacy and per-port entries identify separate endpoints, not a latest pointer', async () => {
    const prior = {
      updatedAt: new Date().toISOString(),
      manuals: {
        ccp3x: makePriorEntry({ url: 'http://localhost:11111/utcp', toolCount: 50 }),
        ccp3x_49650: makePriorEntry({ url: 'http://localhost:49650/utcp', toolCount: 40 }),
      },
    };
    const cfg = {
      manual_call_templates: [
        { name: 'ccp3x', call_template_type: 'http', url: 'http://localhost:11111/utcp', http_method: 'GET', content_type: 'application/json' },
        { name: 'ccp3x_49650', call_template_type: 'http', url: 'http://localhost:49650/utcp', http_method: 'GET', content_type: 'application/json' },
      ],
    };
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: prior,
      fetchJson: mockFetch({
        'http://localhost:11111/utcp': null,
        'http://localhost:11111/build-info': null,
        'http://localhost:49650/utcp': LIVE_MANUAL,
        'http://localhost:49650/build-info': LIVE_BUILD,
      }),
      now: new Date(),
    });
    // Legacy endpoint migrates to its port while the other editor stays independent.
    assert.equal(result.manuals.ccp3x_11111.toolCount, 50);
    assert.equal(result.manuals.ccp3x_11111.live, false);
    assert.equal(result.manuals['ccp3x_49650'].toolCount, 3);
    assert.equal(result.manuals['ccp3x_49650'].live, true);
  });

  it('deduplicates legacy and per-port templates under the endpoint namespace', async () => {
    // Same base URL appears twice (canonical + per-port alias) — dedup should fetch once
    let fetchCount = 0;
    const cfg = {
      manual_call_templates: [
        { name: 'ccp3x_49650', call_template_type: 'http', url: 'http://localhost:49650/utcp', http_method: 'GET', content_type: 'application/json' },
        { name: 'ccp3x', call_template_type: 'http', url: 'http://localhost:49650/utcp', http_method: 'GET', content_type: 'application/json' },
      ],
    };
    const countingFetch = async (url) => {
      if (url.endsWith('/utcp')) fetchCount++;
      if (url.endsWith('/utcp')) return LIVE_MANUAL;
      if (url.endsWith('/build-info')) return LIVE_BUILD;
      return null;
    };
    const result = await buildCache({ utcpConfig: cfg, priorCache: null, fetchJson: countingFetch, now: new Date() });
    // Only the stable per-port namespace survives discovery.
    assert.deepEqual(Object.keys(result.manuals), ['ccp3x_49650']);
    assert.equal(fetchCount, 1, 'should fetch /utcp once per unique URL');
  });
});

describe('ccp-bootstrap — regression: reverting the guard must fail', () => {
  it('the old buggy guard (existing.toolCount>0 only when prior exists) would let first-run 0 persist; new code must not', async () => {
    // This is the exact scenario the original bug report describes: first run,
    // no prior file on disk, editor dead → old code did:
    //   const cache = { manuals: {} }; // fresh
    //   existing = cache.manuals[cacheKey] // undefined
    //   if (existing && existing.toolCount>0 ...) continue; // never fires
    //   cache.manuals[cacheKey] = { toolCount: 0, ... } // authoritative 0 persists forever
    const cfg = utcpConfigFor([{ name: 'ccp3x', port: 11111 }]);
    const result = await buildCache({
      utcpConfig: cfg,
      priorCache: null,
      fetchJson: mockFetch({ 'http://localhost:11111/utcp': null, 'http://localhost:11111/build-info': null }),
      now: new Date(),
    });
    // If the guard were reverted to the old logic, this would be { toolCount:0, authoritative: true/undefined }
    // The regression test asserts the new invariant: a 0 entry is never authoritative
    const entry = result.manuals.ccp3x_11111;
    assert.ok(entry, 'dead first run should still write a tombstone (or be absent) — never silent success');
    assert.notEqual(entry.authoritative, true, 'tombstone must not be authoritative; revert would make this true/undefined');
    assert.equal(entry.stale, true);
    // Consumers key off authoritative to decide "ready"; a revert would make toolCount:0 look ready
    const isReady = entry.authoritative === true && entry.toolCount > 0;
    assert.equal(isReady, false, 'dead first-run entry must not be considered ready');
  });
});

describe('bootstrap stable editor identity', () => {
  it('never carries legacy alias evidence to a different editor port', async () => {
    const priorCache = { manuals: { ccp3x: makePriorEntry({
      handshake: { status: 'responsive', result: { instanceId: 'editor-a' } },
    }) } };
    const cache = await buildCache({
      utcpConfig: utcpConfigFor([{ name: 'ccp3x', port: 22222 }]),
      priorCache, now: new Date(), fetchJson: async () => null,
    });
    assert.equal(cache.manuals.ccp3x, undefined);
    assert.equal(cache.manuals.ccp3x_22222.authoritative, false);
    assert.equal(cache.manuals.ccp3x_22222.toolCount, 0);
    assert.equal(cache.manuals.ccp3x_22222.handshake.result, null);
    assert.equal(cache.manuals.ccp3x_11111.toolCount, 42);
    assert.equal(cache.manuals.ccp3x_11111.live, false);
    assert.equal(cache.manuals.ccp3x_11111.handshake.result, null);
  });

  it('migrates cached aliases once and favors the explicit port entry in either order', async () => {
    const entries = [
      ['ccp3x', makePriorEntry({ toolCount: 99, aliasOf: 'ccp3x_11111' })],
      ['ccp3x_11111', makePriorEntry({ toolCount: 7 })],
    ];
    for (const ordered of [entries, [...entries].reverse()]) {
      const cache = await buildCache({ utcpConfig: null, priorCache: { manuals: Object.fromEntries(ordered) },
        now: new Date(), fetchJson: async () => null });
      assert.deepEqual(Object.keys(cache.manuals), ['ccp3x_11111']);
      assert.equal(cache.manuals.ccp3x_11111.toolCount, 7);
      assert.equal(cache.manuals.ccp3x_11111.aliasOf, undefined);
      assert.equal(cache.manuals.ccp3x_11111.live, false);
    }
  });

  it('deduplicates loopback spellings without retaining a stale alias', async () => {
    const templates = utcpConfigFor([{ name: 'ccp3x', port: 11111 }, { name: 'ccp3x_11111', port: 11111 }]);
    templates.manual_call_templates[0].url = 'http://127.0.0.1:11111/utcp/';
    const urls = [];
    const cache = await buildCache({ utcpConfig: templates,
      priorCache: { manuals: { ccp3x: makePriorEntry() } }, now: new Date(),
      fetchJson: async (url) => { urls.push(url); return url.endsWith('/utcp') ? LIVE_MANUAL : LIVE_BUILD; },
    });
    assert.deepEqual(Object.keys(cache.manuals), ['ccp3x_11111']);
    assert.equal(cache.manuals.ccp3x_11111.url, 'http://localhost:11111/utcp');
    assert.equal(urls.filter((url) => url.endsWith('/utcp')).length, 1);
  });
  it('rejects names that disagree with endpoint ports and ambiguous same-port hosts', async () => {
    const config = utcpConfigFor([{ name: 'ccp3x_22222', port: 11111 },
      { name: 'ccp3x_33333', port: 33333 }, { name: 'ccp3x', port: 33333 }]);
    config.manual_call_templates[2].url = 'http://other-host:33333/utcp';
    let calls = 0;
    const cache = await buildCache({ utcpConfig: config, priorCache: null, now: new Date(),
      fetchJson: async () => { calls++; return LIVE_MANUAL; },
    });
    assert.equal(calls, 0, 'invalid or ambiguous endpoints must not be selected');
    assert.deepEqual(cache.manuals, {});
  });

  it('does not reuse same-port metadata from another host', async () => {
    const cache = await buildCache({ utcpConfig: utcpConfigFor([{ name: 'ccp3x_11111', port: 11111 }]),
      priorCache: { manuals: { ccp3x_11111: makePriorEntry({ url: 'http://other-host:11111/utcp' }) } },
      now: new Date(), fetchJson: async () => null,
    });
    assert.equal(cache.manuals.ccp3x_11111.authoritative, false);
    assert.equal(cache.manuals.ccp3x_11111.url, 'http://localhost:11111/utcp');
    assert.equal(cache.manuals.ccp3x_11111.toolCount, 0);
  });

  it('keeps separate live handshake identities for two editors', async () => {
    const cache = await buildCache({
      utcpConfig: utcpConfigFor([{ name: 'ccp3x', port: 11111 }, { name: 'ccp3x', port: 22222 }]),
      priorCache: null, now: new Date(), fetchJson: async (url) => {
        if (url.endsWith('/utcp')) return { ...LIVE_MANUAL, tools: [{ name: 'editorHandshake' }] };
        if (url.endsWith('/build-info')) return LIVE_BUILD;
        return { instanceId: new URL(url).port, probe: { status: 'responsive', sceneReady: true } };
      },
    });
    assert.deepEqual(Object.keys(cache.manuals).sort(), ['ccp3x_11111', 'ccp3x_22222']);
    assert.equal(cache.manuals.ccp3x_11111.handshake.result.instanceId, '11111');
    assert.equal(cache.manuals.ccp3x_22222.handshake.result.instanceId, '22222');
  });

  it('probes editors concurrently with no more than eight HTTP requests in flight', async () => {
    let active = 0;
    let peak = 0;
    const cache = await buildCache({
      utcpConfig: utcpConfigFor(Array.from({ length: 10 }, (_, i) => ({ name: 'ccp3x', port: 11000 + i }))),
      priorCache: null, now: new Date(), fetchJson: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return null;
      },
    });
    assert.ok(peak > 2 && peak <= 8, `bounded parallel discovery, peak=${peak}`);
    assert.equal(Object.keys(cache.manuals).length, 10);
  });
});

describe('bootstrap HTTP deadline', () => {
  it('rejects HTTP errors and terminates a trickling body at the absolute deadline', async () => {
    const http = require('http');
    const server = http.createServer((req, res) => {
      if (req.url === '/error') { res.writeHead(503); res.end(JSON.stringify(LIVE_MANUAL)); return; }
      res.writeHead(200);
      const timer = setInterval(() => res.write(' '), 5);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal(await bootstrap.fetchJson(`${base}/error`, 1000), null);
      const started = Date.now();
      assert.equal(await bootstrap.fetchJson(`${base}/trickle`, 80), null);
      assert.ok(Date.now() - started < 1500, 'trickling data must not extend the request deadline');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

it('rejects responsive handshake evidence from a replacement instance or wrong project', async () => {
  const cfg = utcpConfigFor([{ name: 'ccp3x_11111', port: 11111 }]);
  cfg.variables = { CCP3X_PROJECT_11111: 'G:/project', CCP3X_OWNER_11111: 'expected-instance' };
  for (const [instanceId, projectMatches, status] of [
    ['replacement-instance', true, 'unverified'],
    ['expected-instance', false, 'unverified'],
    ['expected-instance', true, 'responsive'],
  ]) {
    const cache = await buildCache({ utcpConfig: cfg, priorCache: null, now: new Date(), fetchJson: async url => {
      if (url.endsWith('/utcp')) return { ...LIVE_MANUAL, tools: [{ name: 'editorHandshake' }] };
      if (url.endsWith('/build-info')) return LIVE_BUILD;
      assert.equal(new URL(url).searchParams.get('expectedProjectPath'), 'G:/project');
      return { instanceId, projectMatches, probe: { status: 'responsive', sceneReady: true } };
    } });
    assert.equal(cache.manuals.ccp3x_11111.handshake.status, status);
    if (status === 'unverified') assert.equal(cache.manuals.ccp3x_11111.handshake.result, null);
  }
});
