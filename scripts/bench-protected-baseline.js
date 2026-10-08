#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'reports', 'evidence', 'phase-01', 'baseline.json');

function parseArgs(argv) {
  const out = { repeats: 20, screenshotRepeats: 5, allowMutation: false, gatewayUrl: null, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--allow-mutation') out.allowMutation = true;
    else if (argv[i] === '--gateway-url') out.gatewayUrl = argv[++i].replace(/\/$/, '');
    else if (argv[i] === '--output') out.output = path.resolve(argv[++i]);
    else if (argv[i] === '--repeats') out.repeats = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(out.repeats) || out.repeats < 3 || out.repeats > 1000) throw new Error('--repeats must be 3..1000');
  return out;
}

function discoverManualUrl() {
  return require('./project-connection').selectConnection().url;
}

function percentile(sorted, percentileValue) {
  return sorted[Math.min(Math.ceil(percentileValue / 100 * sorted.length) - 1, sorted.length - 1)];
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length
  };
}

function appendQuery(params, prefix, value) {
  if (Array.isArray(value)) return value.forEach((item) => appendQuery(params, `${prefix}[]`, item));
  if (value && typeof value === 'object') return Object.entries(value).forEach(([key, item]) => appendQuery(params, `${prefix}[${key}]`, item));
  if (value !== undefined) params.append(prefix, String(value));
}

async function requestTool(baseUrl, manualByName, name, args = {}) {
  const tool = manualByName.get(name);
  if (!tool) throw new Error(`Tool absent from live manual: ${name}`);
  const method = tool.tool_call_template.http_method;
  const url = new URL(`${baseUrl}/tools/${name}`);
  const init = { method, headers: require('./project-connection').connectionHeaders(require('./project-connection').selectConnection()) };
  if (method === 'GET') Object.entries(args).forEach(([key, value]) => appendQuery(url.searchParams, key, value));
  else {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args);
  }
  const started = performance.now();
  const response = await fetch(url, init);
  const text = await response.text();
  const durationMs = performance.now() - started;
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${name} -> ${response.status}: ${text.slice(0, 300)}`);
  return { body, durationMs, bytes: Buffer.byteLength(text), serverDurationMs: Number(response.headers.get('x-duration-ms')) || null };
}

async function sampleUrl(url, count) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const started = performance.now();
    const response = await fetch(url, { redirect: 'error' });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    samples.push(performance.now() - started);
  }
  return { samples, summary: summary(samples) };
}

function collectReferences(tree, limit) {
  const references = [];
  const visit = (node, include) => {
    if (include && node?.reference && references.length < limit) references.push(node.reference);
    for (const child of node?.children || []) if (references.length < limit) visit(child, true);
  };
  visit(tree, false);
  return references;
}

async function mutationBaseline(baseUrl, manualByName) {
  const before = await requestTool(baseUrl, manualByName, 'sceneGetInfo');
  if (before.body.dirty) throw new Error('Refusing mutation baseline: active scene was already dirty');
  const name = `__ccb_baseline_${Date.now()}`;
  const created = await requestTool(baseUrl, manualByName, 'nodeCreate', { name });
  const removed = await requestTool(baseUrl, manualByName, 'nodeOperate', { operation: 'delete', reference: created.body.reference });
  const undoDelete = await requestTool(baseUrl, manualByName, 'editorHistory', { operation: 'undo' });
  const undoCreate = await requestTool(baseUrl, manualByName, 'editorHistory', { operation: 'undo' });
  const after = await requestTool(baseUrl, manualByName, 'sceneGetInfo');
  const lookup = await requestTool(baseUrl, manualByName, 'findNodes', { name, maxResults: 5 });
  if (after.body.dirty !== before.body.dirty || lookup.body.total !== 0) throw new Error('Mutation cleanup did not restore scene state');
  return {
    snapshotCount: 2,
    restored: true,
    durationsMs: { create: created.durationMs, delete: removed.durationMs, undoDelete: undoDelete.durationMs, undoCreate: undoCreate.durationMs },
    postState: { dirty: after.body.dirty, temporaryNodeMatches: lookup.body.total }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manualUrl = discoverManualUrl();
  const connection = require('./project-connection').selectConnection();
  await require('./project-connection').verifyConnection(connection);
  if (options.gatewayUrl && new URL(options.gatewayUrl).origin !== connection.gateway.origin) throw new Error('--gateway-url differs from selected project assignment');
  const baseUrl = manualUrl.replace(/\/utcp\/?$/, '');
  const manualResponse = await fetch(manualUrl, { redirect: 'error' });
  const manualText = await manualResponse.text();
  if (!manualResponse.ok) throw new Error(`GET ${manualUrl} -> ${manualResponse.status}`);
  const manual = JSON.parse(manualText);
  const manualByName = new Map(manual.tools.map((tool) => [tool.name, tool]));
  const buildInfoResponse = await fetch(`${baseUrl}/build-info`);
  const buildInfo = buildInfoResponse.ok ? await buildInfoResponse.json() : null;

  const readSamples = [];
  for (let i = 0; i < options.repeats; i += 1) readSamples.push(await requestTool(baseUrl, manualByName, 'sceneGetInfo'));
  const screenshotSamples = [];
  for (let i = 0; i < options.screenshotRepeats; i += 1) {
    const sample = await requestTool(baseUrl, manualByName, 'captureSceneScreenshot', { imageSize: { width: 128, height: 128 }, jpegQuality: 80 });
    screenshotSamples.push({ durationMs: sample.durationMs, responseBytes: sample.bytes, validJpeg: sample.body.data?.startsWith('/9j/') === true });
  }

  const tree = await requestTool(baseUrl, manualByName, 'nodeGetTree', { maxDepth: 4, maxNodes: 80, fields: ['name', 'active'] });
  const references = collectReferences(tree.body, 10);
  if (references.length !== 10) throw new Error(`Need ten child nodes; found ${references.length}`);
  const sequential = [];
  for (const reference of references) sequential.push(await requestTool(baseUrl, manualByName, 'inspectorGet', { target: 'instance', reference, fields: ['name'] }));
  const batched = await requestTool(baseUrl, manualByName, 'sceneBatchGet', { entries: references.map((reference) => ({ target: 'instance', reference, fields: ['name'] })) });
  const sequentialMs = sequential.reduce((sum, sample) => sum + sample.durationMs, 0);

  const evidence = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    profile: { creatorProject: connection.projectPath, gateway: connection.gateway.origin, note: 'Company-LAN and 100-device evidence belong to Phase 5.' },
    manual: { url: manualUrl, toolCount: manual.tools.length, bytes: Buffer.byteLength(manualText), buildInfo },
    smallRead: {
      samples: readSamples.map(({ durationMs, bytes, serverDurationMs }) => ({ durationMs, bytes, serverDurationMs })),
      clientMs: summary(readSamples.map((sample) => sample.durationMs)),
      serverMs: summary(readSamples.map((sample) => sample.serverDurationMs).filter(Number.isFinite)),
      responseBytes: summary(readSamples.map((sample) => sample.bytes)),
      creatorIpcCountPerCall: 1
    },
    screenshot: {
      dimensions: { width: 128, height: 128 },
      samples: screenshotSamples,
      clientMs: summary(screenshotSamples.map((sample) => sample.durationMs)),
      responseBytes: summary(screenshotSamples.map((sample) => sample.responseBytes)),
      allValidJpeg: screenshotSamples.every((sample) => sample.validJpeg),
      resultPath: 'local'
    },
    tenStepRead: {
      sequentialCalls: 10,
      sequentialSamples: sequential.map(({ durationMs, bytes, serverDurationMs }) => ({ durationMs, bytes, serverDurationMs })),
      sequentialMs,
      batchCalls: 1,
      batchMs: batched.durationMs,
      improvementPercent: (1 - batched.durationMs / sequentialMs) * 100,
      batchResults: batched.body.results?.length
    },
    mutation: options.allowMutation ? await mutationBaseline(baseUrl, manualByName) : { skipped: true, reason: 'Pass --allow-mutation on a clean test scene.' },
    gatewayHealthRtt: options.gatewayUrl ? await sampleUrl(`${options.gatewayUrl}/healthz`, options.repeats) : null
  };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output: options.output, toolCount: evidence.manual.toolCount, readP95Ms: evidence.smallRead.clientMs.p95, screenshotP95Ms: evidence.screenshot.clientMs.p95, tenStepImprovementPercent: evidence.tenStepRead.improvementPercent, mutationRestored: evidence.mutation.restored ?? false }));
}

main().catch((error) => {
  console.error(`protected baseline failed: ${error.message}`);
  process.exitCode = 1;
});
