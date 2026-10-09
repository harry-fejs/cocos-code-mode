#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'evidence', 'phase-05');
const SAMPLES = Number(process.env.CCP_BENCH_SAMPLES || '15');
const WARMUPS = Number(process.env.CCP_BENCH_WARMUPS || '3');

const TOOL_CASES = [
  { name: 'sceneGetInfo', args: {} },
  { name: 'nodeGetTree', args: { maxDepth: 3, maxNodes: 40 } },
  { name: 'assetGetTree', args: { maxDepth: 3, maxNodes: 40 } },
  { name: 'editorQuery', args: { operation: 'scene' } },
  { name: 'captureSceneScreenshot', args: { imageSize: { width: 128, height: 128 }, jpegQuality: 80 } },
  { name: 'previewManage', args: { operation: 'scene_preview', imageSize: { width: 128, height: 128 } } },
  { name: 'projectListDirectory', args: { path: 'db://assets', maxResults: 20 } },
  { name: 'editorGetLogs', args: {} },
];

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function summary(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    count: values.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1],
    meanMs: Math.round(mean * 1000) / 1000,
  };
}

function loadToken() {
  const { selectConnection, connectionHeaders } = require('./project-connection');
  return connectionHeaders(selectConnection());
}

function discoverBase() {
  return require('./project-connection').selectConnection().base;
}

async function timedFetch(url, init) {
  const started = performance.now();
  const response = await fetch(url, { redirect: 'error', ...init });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    durationMs: performance.now() - started,
    bytes: Buffer.byteLength(text),
    serverDurationMs: Number(response.headers.get('x-duration-ms')) || null,
    body: text,
  };
}

async function sampleUrl(url, count, init = {}) {
  const samples = [];
  for (let i = 0; i < WARMUPS; i += 1) await timedFetch(url, init);
  for (let i = 0; i < count; i += 1) samples.push(await timedFetch(url, init));
  return {
    lastStatus: samples[samples.length - 1]?.status,
    client: summary(samples.map((s) => s.durationMs)),
    server: summary(samples.map((s) => s.serverDurationMs).filter(Number.isFinite)),
    bytes: summary(samples.map((s) => s.bytes)),
  };
}

async function callTool(base, tool, args, token) {
  const method = tool.tool_call_template.http_method;
  const url = new URL(`${base}/tools/${tool.name}`);
  const headers = { ...token };
  const init = { method, headers };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== undefined) url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  } else {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args || {});
  }
  const result = await timedFetch(url, init);
  let parsed;
  try { parsed = JSON.parse(result.body); } catch { parsed = null; }
  return {
    ...result,
    code: parsed && parsed.code,
    error: parsed && parsed.error,
    bodyPreview: result.body.slice(0, 180),
  };
}

async function sampleTool(base, tool, args, token) {
  const samples = [];
  for (let i = 0; i < WARMUPS; i += 1) await callTool(base, tool, args, token);
  for (let i = 0; i < SAMPLES; i += 1) samples.push(await callTool(base, tool, args, token));
  const ok = samples.filter((s) => s.ok);
  const fail = samples.filter((s) => !s.ok);
  return {
    method: tool.tool_call_template.http_method,
    lastStatus: samples[samples.length - 1]?.status,
    lastCode: samples[samples.length - 1]?.code || null,
    failClosed: fail.length === samples.length && fail[0]?.code === 'CCP_GATEWAY_UNAVAILABLE',
    client: summary(ok.map((s) => s.durationMs) || fail.map((s) => s.durationMs)),
    allClient: summary(samples.map((s) => s.durationMs)),
    server: summary(ok.map((s) => s.serverDurationMs).filter(Number.isFinite)),
    bytes: summary(samples.map((s) => s.bytes)),
    okCount: ok.length,
    failCount: fail.length,
    failPreview: fail[0] ? fail[0].bodyPreview : null,
  };
}

async function main() {
  const connection = require('./project-connection').selectConnection();
  await require('./project-connection').verifyConnection(connection);
  const base = discoverBase();
  const token = loadToken();
  if (!token) throw new Error('no local-auth token in ~/.ccp/local-auth');
  const build = await (await fetch(`${base}/build-info`)).json();
  const manualRes = await timedFetch(`${base}/utcp`);
  const manual = JSON.parse(manualRes.body);
  const byName = new Map(manual.tools.map((tool) => [tool.name, tool]));
  const diagnostics = {
    buildInfo: await sampleUrl(`${base}/build-info`, SAMPLES),
    utcpManual: await sampleUrl(`${base}/utcp`, SAMPLES),
    gatewayHealth: await sampleUrl(require('./project-connection').gatewayHealthUrl(connection), SAMPLES),
  };
  const tools = {};
  for (const testCase of TOOL_CASES) {
    const tool = byName.get(testCase.name);
    if (!tool) {
      tools[testCase.name] = { skipped: true, reason: 'absent from live manual' };
      continue;
    }
    tools[testCase.name] = await sampleTool(base, tool, testCase.args, token);
  }
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    host: { os: `${os.platform()}-${os.arch()}`, cpus: os.cpus().length },
    build,
    manual: { toolCount: manual.tools.length, executeJavascript: manual.tools.some((t) => t.name === 'executeJavascript') },
    samplesPerCase: SAMPLES,
    warmups: WARMUPS,
    diagnostics,
    tools,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUT_DIR, `live-timings-${stamp}.json`);
  const latest = path.join(OUT_DIR, 'live-timings-latest.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(latest, `${JSON.stringify(report, null, 2)}\n`);
  const rows = Object.entries(tools).map(([name, row]) => {
    if (row.skipped) return { name, skipped: true };
    return {
      name,
      status: row.lastStatus,
      code: row.lastCode,
      p50Ms: row.allClient && row.allClient.p50Ms,
      p95Ms: row.allClient && row.allClient.p95Ms,
      maxMs: row.allClient && row.allClient.maxMs,
      failClosed: row.failClosed,
    };
  });
  console.log(JSON.stringify({
    output: outPath,
    latest,
    build: `${build.commit} ${build.branch}`,
    toolCount: manual.tools.length,
    diagnostics: {
      buildInfoP95Ms: diagnostics.buildInfo.client.p95Ms,
      utcpP95Ms: diagnostics.utcpManual.client.p95Ms,
      gatewayHealthP95Ms: diagnostics.gatewayHealth.client.p95Ms,
    },
    tools: rows,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
