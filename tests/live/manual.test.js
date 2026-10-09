'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getJson, healthCheck } = require('../helpers/utcp-client');

describe('live: manual & server — migrated from scripts/smoke-utcp.js', () => {
  let health;
  before(async () => { health = await healthCheck(); });
  function skipIfDown(t) {
    if (!health || !health.ok) { t.skip(`editor not running: ${health ? health.reason : 'no health'} — start Creator 3.7 + ccp3x`); return true; }
    return false;
  }

  it('GET /utcp matches the source inventory and has strict keys', async (t) => {
    if (skipIfDown(t)) return;
    const r = await getJson('/utcp');
    assert.equal(r.ok, true, `GET /utcp -> ${r.status}`);
    assert.deepEqual(Object.keys(r.body).sort(), ['manual_version', 'tools', 'utcp_version']);
    const { execFileSync } = require('node:child_process');
    const root = path.resolve(__dirname, '../..');
    const inventory = JSON.parse(execFileSync(process.execPath, ['scripts/audit-tool-portfolio.js'], { cwd: root, encoding: 'utf8' }));
    assert.equal(r.body.tools.length, inventory.registeredToolCount);
    assert.equal(new Set(r.body.tools.map((tool) => tool.name)).size, r.body.tools.length);
  });

  it('config has ccp3x template, no duplicate ccp* URL', async (t) => {
    if (skipIfDown(t)) return;
    const cfgPath = process.env.UTCP_CONFIG_FILE || path.join(os.homedir(), '.utcp_config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    const names = (cfg.manual_call_templates || []).map(x => x.name);
    const has3x = names.some(n => /^ccp3x_\d+$/.test(n));
    assert.ok(has3x, `ccp3x template present, found ${names.join(',')}`);
    const isCcp = (n) => /^ccp[23]x_\d+$/.test(n);
    const urls = (cfg.manual_call_templates || []).filter(x => isCcp(x.name)).map(x => (x.url || '').replace(/\/utcp\/?$/, ''));
    assert.equal(new Set(urls).size, urls.length, `ccp* duplicate URL: ${urls.join(',')}`);
  });

  it('GET /build-info has commit/branch', async (t) => {
    if (skipIfDown(t)) return;
    const r = await getJson('/build-info');
    assert.equal(r.ok, true, 'GET /build-info ok');
    assert.ok(r.body.commit && r.body.branch, `commit/branch present: ${JSON.stringify(r.body).slice(0, 80)}`);
  });

  it('inspectorGetDefinition CommonTypes pagination', async (t) => {
    if (skipIfDown(t)) return;
    const r = await getJson('/tools/inspectorGetDefinition?target=CommonTypes');
    assert.equal(r.ok, true, 'inspectorGetDefinition ok');
    assert.ok(typeof r.body.definition === 'string' && r.body.definition.length > 100, 'definition non-empty');
    assert.ok(Array.isArray(r.body.sections) && r.body.sections.length >= 10, `sections ${r.body.sections && r.body.sections.length}`);
    assert.equal(r.body.totalSections, r.body.sections.length, 'totalSections matches');
    const one = await getJson('/tools/inspectorGetDefinition?target=CommonTypes&section=Vec3');
    assert.ok(one.body.definition.includes('Vec3'), 'Vec3 section contains Vec3');
    assert.ok(one.body.definition.length < r.body.definition.length, 'single section shorter than full');
  });

  it('assetGetTree maxNodes=5 respects budget and markers', async (t) => {
    if (skipIfDown(t)) return;
    const r = await getJson('/tools/assetGetTree?maxNodes=5');
    assert.equal(r.ok, true, `assetGetTree -> ${JSON.stringify(r.body).slice(0, 120)}`);
    assert.ok(r.body.reference && r.body.name, 'reference/name present');
    assert.ok(Array.isArray(r.body.children), 'children array');
    if (r.body.truncated) {
      assert.ok(['nodeLimit', 'maxDepth'].includes(r.body.truncated), `truncated=${r.body.truncated}`);
      assert.equal(typeof r.body.childrenOmitted, 'number', 'childrenOmitted present');
    }
  });

  it('nodeGetTree maxNodes=5 — not prefab wrapper', async (t) => {
    if (skipIfDown(t)) return;
    const r = await getJson('/tools/nodeGetTree?maxNodes=5');
    if (!r.ok) {
      if (String(r.body && r.body.error || r.text).includes('not found') || r.status === 500) { t.skip('no scene open'); return; }
      assert.fail(`nodeGetTree failed: ${JSON.stringify(r.body).slice(0, 120)}`);
    }
    assert.ok(r.body.reference && r.body.name, 'reference/name');
    assert.ok(Array.isArray(r.body.children), 'children array');
    assert.notEqual(r.body.name, 'New Node', 'not prefab-edit wrapper');
  });

  it('nodeComponentsGet refs have type', async (t) => {
    if (skipIfDown(t)) return;
    const tree = await getJson('/tools/nodeGetTree?maxDepth=2');
    if (!tree.ok) { t.skip('no scene tree'); return; }
    const ids = [tree.body && tree.body.reference && tree.body.reference.id, ...((tree.body.children || []).map(c => c.reference && c.reference.id))].filter(Boolean);
    if (!ids.length) { t.skip('no node ids'); return; }
    let hit = null; let lastErr = null;
    for (const id of ids) {
      const r = await getJson(`/tools/nodeComponentsGet?reference%5Bid%5D=${encodeURIComponent(id)}`);
      if (!r.ok) { lastErr = JSON.stringify(r.body).slice(0, 120); continue; }
      if (r.body && Array.isArray(r.body.references) && r.body.references.length) { hit = r.body; break; }
    }
    if (!hit) { t.skip(lastErr || 'no node with components in top 2 levels'); return; }
    const bad = hit.references.filter(x => !x.type);
    assert.equal(bad.length, 0, `all refs have type, bad ${bad.length}`);
  });

  it('previewManage asset_preview returns valid JPEG /9j/', async (t) => {
    if (skipIfDown(t)) return;
    const q = await getJson('/tools/assetQuery?importer=image&limit=1');
    const img = q.body && q.body.assets && q.body.assets[0];
    if (!img) { t.skip('no image asset'); return; }
    const r = await getJson(`/tools/previewManage?operation=asset_preview&reference%5Bid%5D=${encodeURIComponent(img.uuid)}&imageSize=128`, { method: 'POST' });
    assert.equal(r.ok, true, `previewManage POST ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    assert.equal(r.body.type, 'image', 'type image');
    assert.ok(typeof r.body.data === 'string' && r.body.data.startsWith('/9j/'), `data starts /9j/ got ${String(r.body.data).slice(0, 10)}`);
  });
});
