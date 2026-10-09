#!/usr/bin/env node
// CCP SessionStart hook: fetch live per-port manuals from the selected
// UTCP config and cache discovery metadata to .claude/ccp-cache.json.
// It never registers manuals in the Code Mode MCP process; agents do that per session.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const CANON_3X = 'ccp3x';
const CANON_2X = 'ccp2x';
const PERPORT_3X = /^ccp3x_\d+$/;
const PERPORT_2X = /^ccp2x_\d+$/;

// Max age before a cached entry that has not been re-probed live is marked stale.
// Threshold env-overridable for tests. Discovery freshness is not session readiness.
const STALE_AFTER_MS = Number(process.env.COCOS_PILOT_CACHE_MAX_AGE_MS) || 24 * 60 * 60 * 1000;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function fetchJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let req;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(value);
    };
    // Absolute deadline bounds connect time and trickling response bodies.
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      req = http.get(url, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) { finish(null); return; }
        let body = '';
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) { finish(null); return; }
          body += chunk;
        });
        res.on('error', () => finish(null));
        res.on('aborted', () => finish(null));
        res.on('end', () => { try { finish(JSON.parse(body)); } catch { finish(null); } });
      });
      req.on('error', () => finish(null));
    } catch { finish(null); }
  });
}

function is3x(m) { return PERPORT_3X.test(m?.name); }
function is2x(m) { return PERPORT_2X.test(m?.name); }

function endpointFor(m) {
  if (!is3x(m) && !is2x(m)) return null;
  try {
    const url = new URL(m.url);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/utcp\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) return null;
    const port = Number(url.port || 80);
    const name = `${is3x(m) ? CANON_3X : CANON_2X}_${port}`;
    if (port < 1 || port > 65535 || m.name !== name) return null;
    // localhost and IPv4 loopback are one editor endpoint, not two registrations.
    const base = `http://localhost:${port}`;
    return { name, base, url: `${base}/utcp` };
  } catch { return null; }
}

/**
 * Liveness gate. A probe is LIVE only when ALL hold:
 *  - fetch succeeded (manual is a parsed object with an array tools field)
 *  - toolCount > 0
 *  - provenance present: manual_version/utcp_version OR buildInfo
 * Otherwise the editor is considered dead for this manual — its 0 must never
 * be written as authoritative.
 */
function isLiveProbe(manual, buildInfo, toolCount) {
  if (manual == null) return false;
  if (!Array.isArray(manual.tools)) return false;
  if (toolCount <= 0) return false;
  const hasManualVersion = !!(manual.manual_version || manual.utcp_version);
  const hasBuildInfo = buildInfo != null;
  if (!hasManualVersion && !hasBuildInfo) return false;
  return true;
}

function computeAgeMs(fetchedAt, nowMs) {
  if (!fetchedAt) return null;
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, nowMs - t);
}

function cacheKeyFor(m) {
  return endpointFor(m)?.name;
}

/**
 * Pure core: merge prior disk cache with this run's probes.
 * - Per-port CCP manuals are decided independently; no latest alias is selected.
 * - Live probe → write authoritative entry with fetchedAt/age_ms:0.
 * - Dead probe + prior authoritative entry → retain prior, update age_ms + stale marker, never clobber count.
 * - Dead probe + no prior → tombstone (authoritative:false), never an authoritative 0 entry.
 * - Prior keys not probed this run are retained with age_ms refresh + max-age stale mark.
 * Exported for unit tests (inject fetchJson/now).
 */
async function buildCache({ utcpConfig, priorCache, fetchJson: doFetch, now }) {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const priorManuals = {};
  for (const [name, entry] of Object.entries(priorCache?.manuals || {})) {
    const endpoint = endpointFor({ name, url: entry?.url });
    if (!endpoint) continue;
    const { aliasOf, ...retained } = entry;
    priorManuals[name] = { ...retained, url: endpoint.url };
  }
  const manualsIn = Array.isArray(utcpConfig?.manual_call_templates) ? utcpConfig.manual_call_templates : [];
  // Only exact per-port loopback registrations are probed; never infer project
  // selection from this metadata or forward protected template credentials.
  const byUrl = new Map();
  for (const m of manualsIn) {
    const endpoint = endpointFor(m);
    if (endpoint) byUrl.set(endpoint.base, endpoint);
  }

  // Seed result with prior keys not probed this run (retained with refreshed age_ms).
  const probedKeys = new Set();
  const nextManuals = {};

  // Bring forward every prior key initially; probed ones will be overwritten below.
  // We populate nextManuals lazily inside the loop for probed keys and copy the
  // rest afterwards, so age_ms for untouched keys is still recomputed once.
  for (const [base, m] of byUrl) {
    const cKey = m.name;
    if (probedKeys.has(cKey)) continue;
    probedKeys.add(cKey);

    const manual = await doFetch(`${base}/utcp`);
    const toolDefs = manual && Array.isArray(manual.tools) ? manual.tools : [];
    const tools = toolDefs.map((t) => t.name);
    const buildInfo = await doFetch(`${base}/build-info`);
    const live = isLiveProbe(manual, buildInfo, toolDefs.length);

    const prior = priorManuals[cKey];

    if (live) {
      nextManuals[cKey] = {
        url: m.url,
        toolCount: toolDefs.length,
        tools,
        toolDefs,
        buildInfo: buildInfo || null,
        fetchedAt: nowIso,
        age_ms: 0,
        live: true,
        authoritative: true,
        stale: false,
        discoveryOnly: true,
      };
    } else {
      // Dead probe — never create an authoritative 0 entry.
      if (prior && prior.toolCount > 0 && prior.authoritative !== false) {
        // Retain good prior; update staleness markers.
        const ageMs = computeAgeMs(prior.fetchedAt || prior.updatedAt || priorCache.updatedAt, nowMs);
        const overMaxAge = ageMs != null && ageMs > STALE_AFTER_MS;
        const ageOut = ageMs != null ? ageMs : null;
        nextManuals[cKey] = {
          ...prior,
          age_ms: ageOut != null ? ageOut : prior.age_ms ?? null,
          live: false,
          stale: true,
          staleReason: overMaxAge ? 'max_age' : 'probe_failed',
        };
      } else if (prior && prior.authoritative === false) {
        // Prior was already a tombstone — keep it, refresh age, stay stale.
        const ageMs = computeAgeMs(prior.fetchedAt, nowMs);
        nextManuals[cKey] = {
          ...prior,
          age_ms: ageMs != null ? ageMs : prior.age_ms ?? 0,
          live: false,
          stale: true,
          staleReason: 'probe_failed',
        };
      } else {
        // First-run dead fetch (no good prior): do NOT create an authoritative 0.
        // Write a non-authoritative tombstone so the run is diagnosable but never
        // counted as "ready". Skipping the write entirely would also satisfy the
        // acceptance rule, but a tombstone makes the dead state explicit to the
        // skill and to the log line instead of looking like a missing manual.
        nextManuals[cKey] = {
          url: m.url,
          toolCount: 0,
          tools: [],
          toolDefs: [],
          buildInfo: buildInfo || null,
          fetchedAt: nowIso,
          age_ms: 0,
          live: false,
          authoritative: false,
          stale: true,
          staleReason: 'probe_failed',
          discoveryOnly: true,
        };
      }
    }
  }

  // Retain prior keys that were not probed this run (e.g. a generation absent from
  // utcp_config this session). Their age keeps ticking and max-age still marks them.
  for (const [k, v] of Object.entries(priorManuals)) {
    if (nextManuals[k] !== undefined) continue;
    const ageMs = computeAgeMs(v.fetchedAt || v.updatedAt || priorCache.updatedAt, nowMs);
    nextManuals[k] = { ...v, age_ms: ageMs ?? v.age_ms ?? null, live: false, stale: true,
      staleReason: ageMs != null && ageMs > STALE_AFTER_MS ? 'max_age' : 'not_probed' };
  }

  return { updatedAt: nowIso, manuals: nextManuals };
}

async function main() {
  const home = os.homedir();
  const configuredPath = process.env.UTCP_CONFIG_FILE || path.join(home, '.utcp_config.json');
  const utcpPath = path.resolve(configuredPath.startsWith('~/') || configuredPath.startsWith('~\\')
    ? path.join(home, configuredPath.slice(2)) : configuredPath);
  const utcp = readJson(utcpPath);
  if (!utcp || !Array.isArray(utcp.manual_call_templates) || utcp.manual_call_templates.length === 0) {
    return;
  }
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { selectConnection, verifyConnection } = require('./project-connection');
  // Protected host discovery must prove the exact registry/project/port/session
  // assignment first. This is not editorHandshake, MCP registration or readiness.
  const connection = selectConnection({ configPath: utcpPath, projectPath: process.env.CCP_PROJECT_PATH || projectRoot });
  await verifyConnection(connection);
  const selectedName = `ccp3x_${connection.port}`;
  const selectedConfig = { manual_call_templates: utcp.manual_call_templates.filter((m) => m.name === selectedName) };
  const claudeDir = path.join(projectRoot, '.claude');
  const cachePath = path.join(claudeDir, 'ccp-cache.json');
  const priorCache = readJson(cachePath);
  const sameSession = priorCache?.binding?.projectId === connection.projectId
    && priorCache.binding.port === connection.port && priorCache.binding.relayInstanceId === connection.relayInstanceId;
  const selectedPrior = sameSession ? { ...priorCache, manuals: { [selectedName]: priorCache.manuals?.[selectedName] } } : null;
  const now = new Date();
  const cache = await buildCache({ utcpConfig: selectedConfig, priorCache: selectedPrior, fetchJson, now });
  cache.binding = { projectPath: connection.projectPath, projectId: connection.projectId,
    port: connection.port, relayInstanceId: connection.relayInstanceId, gateway: connection.gateway };

  try {
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {}

  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile && fs.existsSync(path.dirname(envFile))) {
    try { fs.appendFileSync(envFile, `CK_CODE_MODE=discovery-only\n`); } catch {}
    for (const [name, info] of Object.entries(cache.manuals)) {
      try { fs.appendFileSync(envFile, `CK_CODE_MODE_${name.toUpperCase()}=${info.toolCount}\n`); } catch {}
    }
  }

  const names = Object.keys(cache.manuals).join(', ');
  const liveTotal = Object.values(cache.manuals)
    .filter((v) => v.authoritative !== false && v.live !== false)
    .reduce((s, v) => s + (v.toolCount || 0), 0);
  const staleNote = Object.values(cache.manuals).some((v) => v.stale) ? ' (stale)' : '';
  console.log(`[ccp-bootstrap] cached ${names} (${liveTotal} live discovery tools) → .claude/ccp-cache.json${staleNote}`);
}

// Test seam: pure helpers + core. main() path stays fs/http-coupled as before.
module.exports = { STALE_AFTER_MS, fetchJson, isLiveProbe, computeAgeMs, cacheKeyFor, buildCache, is3x, is2x, CANON_3X, CANON_2X };

if (require.main === module) {
  main().catch(() => process.exit(0));
}
