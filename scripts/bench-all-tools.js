#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'evidence', 'phase-05');
const REPEAT_OK = Number(process.env.CCP_BENCH_SAMPLES || '8');
const WARMUPS = 2;

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))].toFixed(3));
}

function summary(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    minMs: Number(sorted[0].toFixed(3)),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    meanMs: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)),
  };
}

function loadToken() {
  const { selectConnection, connectionHeaders } = require('./project-connection');
  return connectionHeaders(selectConnection());
}

function dummyArgs(tool) {
  const required = (tool.inputs && tool.inputs.required) || [];
  const props = (tool.inputs && tool.inputs.properties) || {};
  const args = {};
  const ref = { id: '00000000-0000-0000-0000-000000000000' };
  for (const key of required) {
    const schema = props[key] || {};
    if (Array.isArray(schema.enum) && schema.enum.length) args[key] = schema.enum[0];
    else if (schema.type === 'number' || schema.type === 'integer') args[key] = key === 'scale' ? 1 : 0;
    else if (schema.type === 'boolean') args[key] = false;
    else if (schema.type === 'array') args[key] = key === 'references' || key === 'entries' || key === 'queries' ? [ref] : [];
    else if (key === 'reference' || key === 'parentReference' || key === 'assetReference') args[key] = ref;
    else if (key === 'references') args[key] = [ref];
    else if (/path|Path|filePath|dirPath|assetPath/i.test(key)) args[key] = 'db://assets';
    else if (key === 'hierarchyPath') args[key] = 'Canvas';
    else if (key === 'pattern') args[key] = '*.md';
    else if (key === 'content' || key === 'search' || key === 'replace' || key === 'text') args[key] = 'ccp-bench';
    else if (key === 'combo') args[key] = 'Ctrl+Shift+P';
    else if (key === 'key') args[key] = 'a';
    else if (key === 'name') args[key] = '__ccp_bench';
    else if (key === 'uiType') args[key] = 'Canvas';
    else if (key === 'primitiveType') args[key] = 'cube';
    else if (key === 'preset') args[key] = 'typescript';
    else if (key === 'target') args[key] = 'node';
    else if (key === 'category') args[key] = 'scene';
    else if (key === 'operation') args[key] = 'get';
    else args[key] = 'ccp-bench';
  }
  if (tool.name === 'projectListDirectory') args.dirPath = 'db://assets';
  if (tool.name === 'captureSceneScreenshot') {
    args.imageSize = { width: 64, height: 64 };
    args.jpegQuality = 70;
  }
  return args;
}

async function invoke(base, tool, args, token) {
  const method = tool.tool_call_template.http_method;
  const url = new URL(`${base}/tools/${tool.name}`);
  const headers = { ...token };
  const init = { method, headers, redirect: 'error' };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(args || {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  } else {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args || {});
  }
  const started = performance.now();
  const response = await fetch(url, init);
  const text = await response.text();
  const durationMs = performance.now() - started;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* raw */ }
  return {
    status: response.status,
    ok: response.ok,
    durationMs,
    bytes: Buffer.byteLength(text),
    serverMs: Number(response.headers.get('x-duration-ms')) || null,
    code: parsed && parsed.code || null,
    error: parsed && parsed.error ? String(parsed.error).slice(0, 180) : null,
  };
}

async function main() {
  const connection = require('./project-connection').selectConnection();
  await require('./project-connection').verifyConnection(connection);
  const base = connection.base;
  const token = loadToken();
  const build = await (await fetch(`${base}/build-info`)).json();
  const health = await (await fetch(require('./project-connection').gatewayHealthUrl(connection))).json();
  const manual = await (await fetch(`${base}/utcp`)).json();
  const tools = [];
  for (const tool of manual.tools) {
    const args = dummyArgs(tool);
    const first = await invoke(base, tool, args, token);
    const samples = [first];
    const repeatable = first.ok || first.code === 'CCP_DEVICE_DENIED' || first.code === 'CCP_GATEWAY_UNAVAILABLE';
    if (repeatable) {
      for (let i = 0; i < WARMUPS; i += 1) await invoke(base, tool, args, token);
      for (let i = 1; i < REPEAT_OK; i += 1) samples.push(await invoke(base, tool, args, token));
    }
    const durations = samples.map((s) => s.durationMs);
    tools.push({
      name: tool.name,
      method: tool.tool_call_template.http_method,
      required: (tool.inputs && tool.inputs.required) || [],
      status: first.status,
      code: first.code,
      error: first.error,
      bytes: first.bytes,
      timings: summary(durations),
      samples: samples.length,
    });
  }
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    connection: {
      utcp: `${base}/utcp`,
      gatewayHealth: health,
      build,
      toolCount: manual.tools.length,
      executeJavascript: manual.tools.some((t) => t.name === 'executeJavascript'),
    },
    tools,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, 'all-tools-live-timings.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    jsonPath,
    toolCount: tools.length,
    ok: tools.filter((t) => t.status >= 200 && t.status < 300).length,
    denied: tools.filter((t) => t.code === 'CCP_DEVICE_DENIED').length,
    gatewayUnavailable: tools.filter((t) => t.code === 'CCP_GATEWAY_UNAVAILABLE').length,
    otherFail: tools.filter((t) => t.status >= 400 && t.code !== 'CCP_DEVICE_DENIED' && t.code !== 'CCP_GATEWAY_UNAVAILABLE').length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
