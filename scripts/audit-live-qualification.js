#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const liveDir = path.join(root, 'tests', 'live');
const verbose = process.argv.includes('--verbose') || /^(1|true|yes)$/i.test(process.env.VERBOSE || '');
const recordedAt = new Date().toISOString();

function log(message) {
  if (verbose) console.log(`[live-audit] ${message}`);
}

function configureTraceDefault() {
  if (process.env.UTCP_TEST_TRACE === undefined) process.env.UTCP_TEST_TRACE = '1';
}

function configuredBases() {
  if (process.env.UTCP_BASE) return [process.env.UTCP_BASE.replace(/\/$/, '')];
  if (process.env.UTCP_PORT) return [`http://localhost:${process.env.UTCP_PORT}`];
  try {
    const home = process.env.HOME || process.env.USERPROFILE || require('node:os').homedir();
    const configPath = process.env.UTCP_CONFIG_FILE || path.join(home, '.utcp_config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return [...new Set((config.manual_call_templates || [])
      .filter((template) => /^ccp3x/.test(String(template.name)))
      .map((template) => String(template.url || '').replace(/\/utcp\/?$/, '').replace(/\/$/, ''))
      .filter(Boolean))];
  } catch {
    return [];
  }
}

async function selectBase() {
  const bases = configuredBases();
  const expectedSceneUuid = process.env.UTCP_EXPECT_SCENE_UUID || '';
  const expectedCommit = process.env.UTCP_EXPECT_COMMIT || '';
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/utcp`);
      if (!response.ok) continue;
      if (expectedCommit) {
        const buildResponse = await fetch(`${base}/build-info`);
        if (!buildResponse.ok) {
          log(`endpoint rejected: ${base} build-info -> ${buildResponse.status}`);
          continue;
        }
        const buildInfo = await buildResponse.json();
        if (buildInfo?.commit !== expectedCommit) {
          log(`endpoint rejected: ${base} build ${buildInfo?.commit || 'missing'} != ${expectedCommit}`);
          continue;
        }
      }
      if (expectedSceneUuid) {
        const sceneResponse = await fetch(`${base}/tools/sceneGetInfo`);
        if (!sceneResponse.ok) {
          log(`endpoint rejected: ${base} sceneGetInfo -> ${sceneResponse.status}`);
          continue;
        }
        const sceneInfo = await sceneResponse.json();
        const actualSceneUuid = sceneInfo?.currentScene?.uuid;
        if (actualSceneUuid !== expectedSceneUuid) {
          log(`endpoint rejected: ${base} scene uuid ${actualSceneUuid || 'missing'} != ${expectedSceneUuid}`);
          continue;
        }
      }
      process.env.UTCP_BASE = base;
      return base;
    } catch {
      log(`endpoint unavailable: ${base}`);
    }
  }
  return expectedSceneUuid || expectedCommit ? null : process.env.UTCP_BASE || null;
}

function portfolioSnapshot() {
  const portfolio = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'tool-portfolio-candidates.json'), 'utf8'));
  const rows = [
    ...portfolio.domains.flatMap((domain) => domain.candidates.map((candidate) => ({ ...candidate, domain: domain.domain }))),
    ...(portfolio.reserveCandidates || []).map((candidate) => ({ ...candidate, reserve: true })),
  ];
  const states = {};
  for (const row of rows) states[row.state] = (states[row.state] || 0) + 1;
  return { primary: portfolio.domains.reduce((count, domain) => count + domain.candidates.length, 0), reserve: (portfolio.reserveCandidates || []).length, total: rows.length, states, rows };
}

function staticAudit() {
  const result = spawnSync(process.execPath, ['scripts/audit-tool-portfolio.js'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || 'portfolio audit failed').trim() };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, error: `portfolio audit returned invalid JSON: ${error.message}` };
  }
}

function testFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(entryPath);
    }
  };
  visit(liveDir);
  return files.sort((a, b) => {
    const aName = path.basename(a);
    const bName = path.basename(b);
    return (aName === 'ui-fallback.test.js' ? -1 : bName === 'ui-fallback.test.js' ? 1 : a.localeCompare(b));
  });
}
function transportAudit(files) {
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    if (!/require\(['"](?:\.\.\/|\.\/)+helpers\/utcp-client['"]\)/.test(source)) {
      violations.push(`${relative}: must use the shared CCP client`);
    }
    if (!/\b(?:getJson|postTool|healthCheck|liveWitness)\s*\(/.test(source)) {
      violations.push(`${relative}: has no observable CCP call`);
    }
    if (/\bfetch\s*\(|\bhttps?\.request\s*\(|\baxios\b/.test(source)
        && !/\bfetchTargetUrl\s*\(/.test(source)) {
      violations.push(`${relative}: bypasses the shared CCP client`);
    }
  }
  return { ok: violations.length === 0, checkedFiles: files.length, violations };
}


function referencedTools(file) {
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/(?:getJson\(\s*[`'\"]\/tools\/|postTool\(\s*['\"])([a-z][A-Za-z0-9]+)/g)) names.add(match[1]);
  return [...names].sort();
}

function parseSummary(output) {
  const value = (label) => {
    const match = output.match(new RegExp(`# ${label} (\\d+)`));
    return match ? Number(match[1]) : null;
  };
  return { tests: value('tests'), pass: value('pass'), fail: value('fail'), skipped: value('skipped'), durationMs: value('duration_ms') };
}

function runLiveFile(file) {
  return new Promise((resolve, reject) => {
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', relative], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { const text = chunk.toString(); stdout += text; if (verbose) process.stdout.write(text); });
    child.stderr.on('data', (chunk) => { const text = chunk.toString(); stderr += text; if (verbose) process.stderr.write(text); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function aggregateSummary(runs) {
  return runs.reduce((total, run) => {
    const summary = parseSummary(run.stdout);
    for (const key of ['tests', 'pass', 'fail', 'skipped', 'durationMs']) total[key] = (total[key] || 0) + (summary[key] || 0);
    return total;
  }, { tests: 0, pass: 0, fail: 0, skipped: 0, durationMs: 0 });
}

function statusForRun(run) {
  const summary = parseSummary(run.stdout);
  if (run.code !== 0 || (summary.fail || 0) > 0) return 'failed';
  if ((summary.skipped || 0) > 0) return 'partial-or-skipped';
  return 'passed';
}

async function main() {
  const base = await selectBase();
  configureTraceDefault();
  const files = testFiles();
  log(`starting ${files.length} live test files${base ? ` against ${base}` : ''}`);
  const portfolio = portfolioSnapshot();
  const staticAuditResult = staticAudit();
  const transportAuditResult = transportAudit(files);
  const runs = [];
  for (const file of files) {
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    log(`running ${relative}`);
    let run = await runLiveFile(file);
    let attempts = 1;
    if (run.code !== 0) {
      log(`retrying failed live file ${relative}`);
      run = await runLiveFile(file);
      attempts = 2;
    }
    runs.push({ ...run, attempts });
  }
  const summary = aggregateSummary(runs);
  const fileResults = files.map((file, index) => ({
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    tools: referencedTools(file),
    status: statusForRun(runs[index]),
    summary: parseSummary(runs[index].stdout),
    attempts: runs[index].attempts,
  }));
  const toolFiles = new Map();
  for (const result of fileResults) {
    for (const tool of result.tools) {
      if (!toolFiles.has(tool)) toolFiles.set(tool, []);
      toolFiles.get(tool).push(result);
    }
  }
  const tools = [...toolFiles.entries()].map(([name, results]) => ({
    name,
    liveSuiteStatus: results.some((result) => result.status === 'failed') ? 'failed' : results.some((result) => result.status === 'partial-or-skipped') ? 'partial-or-skipped' : 'passed',
    testFiles: results.map((result) => result.file),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const report = {
    schemaVersion: 1,
    recordedAt,
    mode: verbose ? 'verbose' : 'quiet',
    target: { baseUrl: process.env.UTCP_BASE || null, port: process.env.UTCP_PORT || null },
    portfolio: { primary: portfolio.primary, reserve: portfolio.reserve, total: portfolio.total, states: portfolio.states },
    staticPortfolioAudit: staticAuditResult,
    liveTransportAudit: transportAuditResult,
    liveSuite: { command: `node --test --test-reporter=tap ${files.map((file) => path.relative(root, file).replaceAll(path.sep, '/')).join(' ')}`, exitCode: runs.some((run) => run.code !== 0) ? 1 : 0, summary, files: fileResults },
    tools,
    limitations: [
      'A passing live test file is attributed to referenced tools, but does not automatically promote portfolio state.',
      'Tools without a dedicated live test reference are not live-qualified by this run.',
      'Candidate-specific evidence artifacts and P7 approval reconciliation remain required for release qualification.',
    ],
  };
  const outputPath = path.join(root, 'reports', `live-qualification-audit-${recordedAt.slice(0, 10)}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`live qualification audit: ${outputPath}`);
  if (staticAuditResult.ok === false) console.error(`portfolio audit: FAILED — ${staticAuditResult.error}`);
  else console.log(`portfolio: ${staticAuditResult.registeredToolCount} registered, ${staticAuditResult.approvedCount} approved/implemented, ready=${staticAuditResult.readyForBulkImplementation}`);
  if (!transportAuditResult.ok) console.error(`live transport audit: FAILED — ${transportAuditResult.violations.join('; ')}`);
  else console.log(`live transport audit: ${transportAuditResult.checkedFiles} files use traced CCP calls`);
  console.log(`live suite: ${summary.pass} pass, ${summary.fail} fail, ${summary.skipped} skipped`);
  if (staticAuditResult.ok === false || !transportAuditResult.ok || runs.some((run) => run.code !== 0)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => { console.error(`live qualification audit failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { configuredBases, configureTraceDefault, selectBase };
