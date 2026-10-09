#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveGraphOutName } from '../../../tools/cocos-graph/src/output-path.mjs';
import { PARSER_VERSION } from '../../../tools/cocos-graph/src/manifest.mjs';
import { readJson } from '../../../tools/cocos-graph/src/storage.mjs';

// Gate mirrors arch.md section 5 / Unity Coplay age_ms > 2000 -> is_stale.
const STALE_MS = Number(process.env.CCP_SESSION_STALE_MS || 2000);
const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PREFIX = '[ccp-session]';

function readSessionJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function ageOf(session) {
  const stamp = Date.parse(String(session?.updatedAt ?? ''));
  if (Number.isFinite(stamp)) return Date.now() - stamp;
  const hint = Number(session?.age_ms);
  return Number.isFinite(hint) ? hint : null;
}

function projectDir(session) {
  const p = process.env.CC_PROJECT_DIR || session?.project;
  if (!p) return null;
  try { return fs.statSync(p).isDirectory() ? p : null; } catch { return null; }
}

function fmt(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function main() {
  const session = readSessionJson(path.join(ROOT, '.claude', 'ccp-session.json'));
  if (!session) return null;

  const banner = [];
  let stale = false;
  const note = (msg) => { stale = true; banner.push(msg); };

  const where = [
    session.bundle && `bundle=${session.bundle}`,
    session.sceneUuid && `scene=${session.sceneUuid}`,
    session.workingPath && `node=${session.workingPath}`,
  ].filter(Boolean).join(' ');
  if (session.task) banner.push(`last context: ${session.task}${where ? ` (${where})` : ''}`);

  const sessionAge = ageOf(session);
  if (sessionAge !== null && sessionAge > STALE_MS) {
    note(`session artifact is ${fmt(sessionAge)} old — re-verify before acting on it`);
  }

  const project = projectDir(session);
  if (!project) {
    note('no project in ccp-session.json — cannot locate .cocos-graph/_manifest.json; treat any remembered graph as unbuilt');
    return { banner, stale };
  }

  const graphOutName = resolveGraphOutName({
    isolate: process.env.CC_GRAPH_ISOLATE === '1',
    cwd: ROOT,
  });
  const manifest = readJson(path.join(project, graphOutName, '_manifest.json'));
  if (!manifest || !Array.isArray(manifest.shards)) {
    note(`index NOT BUILT for ${project} (${graphOutName}) — run cocos-graph build --project "${project}" --out "${graphOutName}" --bundle <name> before any structural query`);
    return { banner, stale };
  }
  if (manifest.parserVersion !== PARSER_VERSION) {
    note(`index parserVersion=${manifest.parserVersion ?? 'missing'} is stale; version ${PARSER_VERSION} required — rebuild before querying`);
    return { banner, stale };
  }

  const shard = manifest.shards.find((s) => s.name === session.bundle);
  if (!shard) {
    note(`no shard "${session.bundle}" in _manifest.json (parserVersion ${manifest.parserVersion}) — build it or scope to an existing bundle`);
    return { banner, stale };
  }

  const shardBuiltAt = Number.isFinite(shard.builtAt) ? shard.builtAt : manifest.builtAt;
  const builtAge = Number.isFinite(shardBuiltAt) ? Date.now() - shardBuiltAt : null;

  if (Number.isFinite(shardBuiltAt) && Number.isFinite(sessionAge) && shardBuiltAt < Date.now() - sessionAge) {
    note(`_manifest.json built ${fmt(builtAge)} ago, BEFORE the last recorded scene edit — shard is advisory, rebuild it`);
  }

  const status = `shard "${shard.name}": source=${shard.source ?? 'disk'} files=${shard.files ?? '?'}${shard.liveNodes != null ? ` liveNodes=${shard.liveNodes}` : ''} dirty=${shard.dirty ?? 'unknown'} age=${fmt(builtAge)} parserVersion=${manifest.parserVersion}`;
  if (stale) banner.unshift(status);
  else banner.push(status);

  if (shard.dirty !== false) {
    note(`shard "${shard.name}" dirty=${shard.dirty ?? 'unknown'} — structure is advisory until sceneGetInfo confirms the live scene`);
  }
  if (shard.prefabOpaque === true) {
    note(`shard "${shard.name}" prefabOpaque=true — disk records omit expanded prefab internals; verify the target with nodeGetTree`);
  }
  if (Number.isFinite(builtAge) && builtAge > STALE_MS) {
    note(`index age_ms=${builtAge} exceeds gate ${STALE_MS} — trust it for structure only, never for values`);
  }

  banner.push(stale
    ? 'stale signal above: re-check ccp3x_49650.sceneGetInfo().dirty and fall back to nodeGetTree before any write'
    : 'dirty is unknown offline — call ccp3x_49650.sceneGetInfo() before relying on structure for a write');
  return { banner, stale };
}

try {
  const result = main();
  if (result?.banner?.length) {
    console.log(`${PREFIX} ${result.stale ? 'STALE — advisory, non-blocking' : 'resumed context — index looks fresh'}:`);
    for (const line of result.banner) console.log(`${PREFIX} - ${line}`);
  }
} catch {}
