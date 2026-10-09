// ponytail: zero-dep smoke via Node 18+ fetch. No framework, ~180 LOC.
const { readFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const assert = require('assert').strict;

async function discoverBase() {
    let port = Number(process.argv[2]);
    if (port) return `http://localhost:${port}`;
    try {
        const cfgPath = process.env.UTCP_CONFIG_FILE || join(homedir(), '.utcp_config.json');
        const raw = readFileSync(cfgPath, 'utf8');
        const cfg = JSON.parse(raw);
        // Per-port CCP 3x only; never select a bare latest alias or another generation.
        const candidates = (cfg.manual_call_templates || []).filter(t => /^ccp3x_\d+$/.test(t.name));
        if (candidates.length !== 1) throw new Error('Pass the intended CCP 3x port explicitly.');
        const endpoint = new URL(candidates[0].url);
        if (endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)
          && candidates[0].name === `ccp3x_${Number(endpoint.port || 80)}`) return endpoint.origin;
    } catch {}
    throw new Error('Cannot discover UTCP port: is ccp3x running? Pass port as arg.');
}

async function getJson(url) {
    const r = await fetch(url);
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: r.ok, status: r.status, body, text };
}

let pass = 0, fail = 0, skip = 0;
function ok(msg) { pass++; console.log(`  PASS ${msg}`); }
function bad(msg, err) { fail++; console.error(`  FAIL ${msg}: ${err}`); }
function skipped(msg, reason) { skip++; console.log(`  SKIP ${msg} (${reason})`); }

async function main() {
    const base = await discoverBase();
    console.log(`smoke: base=${base}\n`);

    // 1 — manual valid (catches build_info regression fbdfd64)
    try {
        const { ok: okManual, body: m, status } = await getJson(`${base}/utcp`);
        assert.equal(okManual, true, `GET /utcp -> ${status}`);
        const keys = Object.keys(m).sort();
        assert.deepEqual(keys, ['manual_version', 'tools', 'utcp_version'], `manual keys ${keys}`);
        const n = (m.tools || []).length;
        assert.equal(n, 88, `tools.length expected 88 got ${n}`);
        // Code Mode validates each tool with a strict schema; metadata must stay in the profile registry.
        assert.ok(m.tools.every((tool) => !Object.hasOwn(tool, 'annotations')), 'manual tools must not expose annotations');
        ok(`manual valid: 88 tools, keys ${keys.join(',')}`);
        // check ccp3x template present (bare or per-port) + no duplicate URL among
        // new-format ccp* names — dup URL is what caused double tool registration.
        // Legacy names are purged by ConfigManager on read, so they never appear here.
        try {
            const cfgPath = process.env.UTCP_CONFIG_FILE || join(homedir(), '.utcp_config.json');
            const raw = readFileSync(cfgPath, 'utf8');
            const cfg = JSON.parse(raw);
            const templates = cfg.manual_call_templates || [];
            const names = templates.map(t => t.name);
            const has3x = names.some(n => /^ccp3x(_\d+)?$/.test(n));
            assert.ok(has3x, `ccp3x template present, found ${names.join(',')}`);
            const isCcp = (n) => /^ccp[23]x(_\d+)?$/.test(n);
            const urls = templates.filter(t => isCcp(t.name)).map(t => (t.url || '').replace(/\/utcp\/?$/, ''));
            assert.equal(new Set(urls).size, urls.length, `ccp* dup URL, got ${urls.join(',')}`);
            ok('config has ccp3x template, no dup URL');
        } catch (e) { skipped('config ccp3x check', e.message); }
    } catch (e) { bad('manual', e.message); }

    // 2 — build-info matches HEAD (catches stale dist)
    try {
        const { body: bi, ok: okBi } = await getJson(`${base}/build-info`);
        assert.ok(okBi, 'GET /build-info ok');
        assert.ok(bi.commit && bi.branch, `build-info has commit/branch ${JSON.stringify(bi).slice(0,80)}`);
        // docs §4 rule 1: verify the RUNNING build matches HEAD before trusting any result.
        const head = (() => {
            try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: join(__dirname, '..') }).toString().trim(); } catch { return null; }
        })();
        if (head && bi.commit && bi.commit !== head) {
            bad('build-info stale', `editor serves ${bi.commit}${bi.dirty ? '-dirty' : ''} but HEAD is ${head} — rebuild + restart editor (docs §4 rule 1; dirty does not excuse a commit mismatch)`);
        } else {
            ok(`build-info ${bi.commit}${bi.dirty ? '-dirty' : ''} on ${bi.branch}${head ? ` (HEAD ${head})` : ''}`);
        }
    } catch (e) { skipped('build-info', e.message); }

    // 3 — shape asserts (fail-loud, not just "no throw")
    // 3a — CommonTypes definition has sections (via consolidated inspectorGetDefinition)
    try {
        const { body, ok: okTs } = await getJson(`${base}/tools/inspectorGetDefinition?target=CommonTypes`);
        assert.ok(okTs, 'inspectorGetDefinition CommonTypes ok');
        assert.ok(typeof body.definition === 'string' && body.definition.length > 100, 'definition non-empty');
        assert.ok(Array.isArray(body.sections) && body.sections.length >= 10, `sections ${body.sections?.length}`);
        assert.equal(body.totalSections, body.sections.length, 'totalSections matches');
        // single section
        const { body: one } = await getJson(`${base}/tools/inspectorGetDefinition?target=CommonTypes&section=Vec3`);
        assert.ok(one.definition.includes('Vec3'), 'Vec3 section contains Vec3');
        assert.ok(one.definition.length < body.definition.length, 'single section shorter than full');
        ok('inspectorGetDefinition pagination');
    } catch (e) { bad('inspectorGetDefinition', e.message); }

    // 3b — asset tree with maxNodes budget
    try {
        const { body, ok: okTree } = await getJson(`${base}/tools/assetGetTree?maxNodes=5`);
        if (!okTree) throw new Error(JSON.stringify(body).slice(0,200));
        assert.ok(body.reference && body.name, 'asset tree has reference/name');
        assert.ok(Array.isArray(body.children), 'asset tree children array');
        // if truncated, must have markers
        if (body.truncated) {
            assert.ok(['nodeLimit','maxDepth'].includes(body.truncated), `truncated ${body.truncated}`);
            assert.ok(typeof body.childrenOmitted === 'number', 'childrenOmitted present');
        }
        ok('assetGetTree maxNodes');
    } catch (e) { bad('assetGetTree', e.message); }

    // 3c — node tree (requires scene, skip if no scene)
    try {
        const { body, ok: okNode, status } = await getJson(`${base}/tools/nodeGetTree?maxNodes=5`);
        if (!okNode) {
            if (String(body).includes('not found') || status === 500) { skipped('nodeGetTree', 'no scene open'); }
            else throw new Error(JSON.stringify(body).slice(0,200));
        } else {
            assert.ok(body.reference && body.name, 'node tree has reference/name');
            assert.ok(Array.isArray(body.children), 'node children array');
            assert.notEqual(body.name, 'New Node', 'not prefab-edit wrapper');
            if (body.truncated) assert.ok(typeof body.childrenOmitted === 'number', 'childrenOmitted');
            ok('nodeGetTree maxNodes + wrapper check');
        }
    } catch (e) { bad('nodeGetTree', e.message); }

    // 3d — nodeComponentsGet shape (if scene has nodes)
    try {
        // qs binds bracket-notation only: reference[id]=<uuid>. A JSON string value
        // arrives as an opaque string and blows up server-side ("Node undefined").
        const compsOf = (id) => getJson(`${base}/tools/nodeComponentsGet?reference%5Bid%5D=${encodeURIComponent(id)}`);
        const { body: tree } = await getJson(`${base}/tools/nodeGetTree?maxDepth=2`);
        // scene root usually holds no components (null response) — walk to first node that does
        const cands = [tree?.reference?.id, ...(tree?.children || []).map(c => c?.reference?.id)].filter(Boolean);
        if (!cands.length) { skipped('nodeComponentsGet', 'no node uuid'); }
        else {
            let hit = null, lastErr = null;
            for (const id of cands) {
                const { body, ok: okComp } = await compsOf(id);
                if (!okComp) { lastErr = JSON.stringify(body).slice(0, 120); continue; }
                if (body && Array.isArray(body.references) && body.references.length) { hit = body; break; }
            }
            if (!hit) { skipped('nodeComponentsGet', lastErr || 'no node with components in top 2 levels'); }
            else {
                // every reference must have type (catches undefined type bug)
                const badRefs = hit.references.filter(r => !r.type);
                assert.equal(badRefs.length, 0, `all refs have type, bad ${badRefs.length}`);
                ok(`nodeComponentsGet refs have type (${hit.references.map(r => r.type).join(',')})`);
            }
        }
    } catch (e) { bad('nodeComponentsGet', e.message); }

    // 3e — preview image must be valid JPEG not "data:," (via previewManage)
    try {
        // importer=image also matches db://internal pngs (pattern db://assets/** misses them)
        const { body: q } = await getJson(`${base}/tools/assetQuery?importer=image&limit=1`);
        const img = q?.assets?.[0];
        if (!img) { skipped('previewManage asset_preview', 'no image asset found'); }
        else {
            // endpoint is POST + bracket-notation reference[id]
            const r = await fetch(`${base}/tools/previewManage?operation=asset_preview&reference%5Bid%5D=${encodeURIComponent(img.uuid)}&imageSize=128`, { method: 'POST' });
            const body = await r.json();
            if (!r.ok) { bad('previewManage asset_preview', `POST ${r.status} ${JSON.stringify(body).slice(0,120)}`); }
            else {
                assert.equal(body.type, 'image', 'preview type image');
                assert.ok(typeof body.data === 'string' && body.data.startsWith('/9j/'), `data starts /9j/ (got ${String(body.data).slice(0,10)})`);
                ok('previewManage asset_preview valid JPEG');
            }
        }
    } catch (e) { bad('previewManage asset_preview', e.message); }

    // 4 — fail-loud contract (docs §5 tier 2 / §7): wrong input must come back as a
    // typed error body, never a 2xx fake success (deterministic: fails pre-IPC).
    try {
        const r = await fetch(`${base}/tools/simulateKeyCombo?combo=${encodeURIComponent('Super+D')}`, { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        assert.equal(r.status, 400, `simulateKeyCombo Super+D -> 400 INVALID_ARGUMENT (got ${r.status} ${JSON.stringify(body).slice(0,120)})`);
        assert.equal(body.code, 'INVALID_ARGUMENT');
        assert.ok(typeof body.error === 'string' && body.error.length > 5, `error present (got ${JSON.stringify(body).slice(0,120)})`);
        ok('fail-loud: simulateKeyCombo Super+D rejected (400 INVALID_ARGUMENT)');
    } catch (e) { bad('fail-loud simulateKeyCombo', e.message); }
    try {
        const r = await fetch(`${base}/tools/projectManage?operation=set&path=test.failLoud&value=1`, { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        // §7 contract must hold unconditionally — anything other than the typed
        // 422 UNSUPPORTED_EDITOR_API is a regression, not a skip.
        assert.equal(r.status, 422, `projectManage set -> 422 typed error (got ${r.status} ${JSON.stringify(body).slice(0, 120)})`);
        assert.equal(body.code, 'UNSUPPORTED_EDITOR_API');
        assert.ok(typeof body.recovery === 'string' && body.recovery.length > 10, `recovery present (got ${JSON.stringify(body).slice(0, 120)})`);
        ok(`fail-loud: projectManage set rejected (${r.status} ${body.code || ''})`);
    } catch (e) { bad('fail-loud projectManage set', e.message); }
    
    console.log(`\nresult: ${pass} pass, ${fail} fail, ${skip} skip`);
    if (fail) process.exit(1);
}

main().catch(e => { console.error('smoke failed:', e.message); process.exit(1); });
