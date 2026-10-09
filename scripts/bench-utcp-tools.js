// ponytail: zero-dep bench via Node 18+ global fetch. No build needed.
const { readFileSync, existsSync, readdirSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const CONCURRENCY = 1; // keep 1 to measure pure tool cost; bump for throughput
const REPEATS = 20;

function pctl(sorted, q) {
    if (!sorted.length) return 0;
    const i = Math.ceil((q / 100) * sorted.length) - 1;
    return sorted[Math.min(i, sorted.length - 1)];
}

async function discoverPort() {
    // 1) editor's UTCP config (ground truth)
    try {
        const cfgPath = process.env.UTCP_CONFIG_FILE || join(homedir(), '.utcp_config.json');
        const raw = readFileSync(cfgPath, 'utf8');
        const cfg = JSON.parse(raw);
        const candidates = (cfg.manual_call_templates || []).filter(t => /^ccp3x_\d+$/.test(t.name));
        if (candidates.length !== 1) throw new Error('Pass the intended CCP 3x port explicitly.');
        const endpoint = new URL(candidates[0].url);
        if (endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)
          && candidates[0].name === `ccp3x_${Number(endpoint.port || 80)}`) return Number(endpoint.port || 80);
    } catch {}
    // 2) build-info artifact (next best)
    try {
        const raw2 = readFileSync(join(__dirname, '..', 'dist', 'build-info.json'), 'utf8');
        void raw2;
    } catch {}
    throw new Error('Cannot discover UTCP port: is the editor running ccp3x?');
}

async function main() {
    let port = Number(process.argv[2]);
    if (!port) port = await discoverPort();
    const base = `http://localhost:${port}`;
    console.log(`bench: base=${base} concurrency=${CONCURRENCY} repeats=${REPEATS}\n`);

    // 0 — manual
    let t0 = Date.now();
    let r = await fetch(`${base}/utcp`);
    if (!r.ok) throw new Error(`GET /utcp -> ${r.status} ${await r.text()}`);
    const manual = await r.json();
    const dtManual = Date.now() - t0;
    const toolNames = (manual.tools || []).map(t => t.name);
    console.log(`GET /utcp: ${dtManual}ms  tools=${toolNames.length}  bytes=${JSON.stringify(manual).length}`);

    // 1 — build-info (prove zip mapping)
    try {
        r = await fetch(`${base}/build-info`);
        const bi = await r.json();
        console.log(`GET /build-info: ${bi.version} (${bi.commit}${bi.dirty ? '-dirty' : ''} on ${bi.branch})`);
    } catch {}

    // 2 — representative single-tool lap (keeps benchmark focused)
    const url = `${base}/tools/inspectorGetDefinition?target=CommonTypes`;
    const durs = [], sizes = [];
    for (let i = 0; i < REPEATS; i++) {
        t0 = Date.now();
        r = await fetch(url);
        const body = await r.text();
        const dt = Date.now() - t0;
        if (!r.ok) throw new Error(`smoke lap ${i} -> ${r.status}: ${body.slice(0, 200)}`);
        durs.push(dt);
        sizes.push(body.length);
    }
    durs.sort((a, b) => a - b);
    sizes.sort((a, b) => a - b);
    console.log(`\nSmoke ${REPEATS}x GET /tools/inspectorGetDefinition?target=CommonTypes`);
    console.log(`  duration ms  p50=${pctl(durs, 50)} p95=${pctl(durs, 95)} avg=${(durs.reduce((a,b)=>a+b,0)/durs.length).toFixed(1)} min=${durs[0]} max=${durs[durs.length-1]}`);
    console.log(`  payload bytes p50=${pctl(sizes, 50)} p95=${pctl(sizes, 95)} avg=${(sizes.reduce((a,b)=>a+b,0)/sizes.length).toFixed(0)}`);

    // 3 — debug logs tail (durationMs corroboration from extension side)
    try {
        r = await fetch(`${base}/debug-logs?last=5`);
        if (r.ok) {
            const logs = await r.json();
            console.log(`\n/debug-logs (last 5): debug=${Array.isArray(logs) ? logs.length : 'n/a'} entries`);
            if (Array.isArray(logs) && logs.length) {
                for (const e of logs.slice(-3)) {
                    console.log(`  ${e.tool || e.type}  size=${e.size ?? '-'}  durationMs=${e.durationMs ?? '-'}`);
                }
            }
        } else {
            console.log('\n/debug-logs: disabled (toggle Debug Logging to enable per-tool durationMs)');
        }
    } catch {}

    // 4 — hint for throughput run
    console.log(`\nThroughput: npx autocannon -c 8 -d 8 ${base}/utcp  (or: wrk -t2 -c8 -d8s ${base}/utcp)`);
    console.log(`Code-mode e2e: measure code-mode.call_tool_chain wall clock in your MCP client's trace — extension trim never reaches LLM context by design.`);
}

main().catch(e => { console.error('bench failed:', e.message); process.exit(1); });
