#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'docs', 'protected-tool-classification.json');
const SOURCE_DIRS = [path.join(ROOT, 'source', 'utcp', 'tools'), path.join(ROOT, 'source', 'utcp', 'execute')];
const DISPOSITIONS = ['gateway-protected', 'local-public', 'relay-internal', 'internal-dev-only', 'removed'];
const DATA_CLASSES = ['public-metadata', 'project-metadata', 'local-payload', 'forbidden'];
const PROVENANCE = ['request', 'creator-ipc', 'public-contract-constant', 'local-derived', 'forbidden'];
const TRANSFER_POLICIES = ['allowed', 'never'];
const SURFACE_KINDS = ['route', 'middleware', 'storage', 'log', 'emission', 'package', 'ui-action', 'scene-export', 'panel-ipc', 'process'];
const SURFACE_DISPOSITIONS = ['authenticated', 'redacted', 'removed', 'allowlisted', 'typed-adapter'];
const REQUIRED_SURFACES = [
  'route.tools', 'route.manual', 'route.build-info', 'route.debug-logs', 'middleware.cors',
  'middleware.json-body', 'middleware.default-deny', 'storage.debug-jsonl',
  'storage.manual-config', 'storage.profile-config', 'log.console', 'emission.typescript',
  'package.dist', 'package.dependencies', 'package.static-assets', 'process.open-debug-folder',
  'process.program-url-fallback', 'scene-export.toggle-console-capture', 'scene-export.run-code',
  'panel-ipc.preview-function', 'ui-action.debug-menus'
];
const EXECUTION_SINKS = [
  { surfaceId: 'process.open-debug-folder', file: 'source/main.ts', pattern: /\bexec\(cmd,/ },
  { surfaceId: 'process.program-url-fallback', file: 'source/utcp/tools/program-tools.ts', pattern: /\bexecFile\(command,/ },
  { surfaceId: 'scene-export.toggle-console-capture', file: 'source/main.ts', pattern: /execute-scene-script[\s\S]{0,100}\bmethod\b/ },
  { surfaceId: 'scene-export.run-code', file: 'source/scene.ts', pattern: /async runCode\([\s\S]{0,500}new Function\(/ },
  { surfaceId: 'panel-ipc.preview-function', file: 'source/panels/preview/index.ts', pattern: /call-preview-function[\s\S]{0,100}\bfunc\b/ },
  { toolId: 'executeJavascript', dispositions: ['removed'], file: 'source/utcp/execute/execute-tool.ts', pattern: /new Function\(/ },
  { toolId: 'callComponentMethod', dispositions: ['removed'], file: 'source/utcp/tools/scene-tools.ts', pattern: /execute-component-method/ },
  { toolId: 'runScriptDiagnostics', dispositions: ['internal-dev-only'], file: 'source/utcp/tools/diagnostics-tools.ts', pattern: /execFileAsync\(/ }
];

function sourceInventory() {
  const inventory = new Map();
  for (const directory of SOURCE_DIRS) {
    for (const filename of fs.readdirSync(directory).filter((name) => name.endsWith('.ts')).sort()) {
      const absolute = path.join(directory, filename);
      const source = fs.readFileSync(absolute, 'utf8');
      const matcher = /@utcpTool\s*\(\s*(['"])([^'"]+)\1/g;
      for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
        if (inventory.has(match[2])) throw new Error(`duplicate source tool: ${match[2]}`);
        inventory.set(match[2], path.relative(ROOT, absolute).replace(/\\/g, '/'));
      }
    }
  }
  return inventory;
}

function manualUrl(explicit) {
  return require('./project-connection').selectConnection({ url: explicit }).url;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function literalRouteInventory() {
  const source = fs.readFileSync(path.join(ROOT, 'source', 'utcp', 'utcp-server.ts'), 'utf8');
  return [...source.matchAll(/this\.app\.(?:get|post|put|delete)\(\s*(['\"])(\/[^'\"]+)\1/g)]
    .map((match) => match[2])
    .sort();
}

function assertDataFlow(toolId, field, direction, disposition) {
  if (!field || typeof field.jsonPointer !== 'string' || !DATA_CLASSES.includes(field.dataClass)) {
    throw new Error(`${toolId}: invalid ${direction} field`);
  }
  if (!Array.isArray(field.provenance) || field.provenance.length === 0
      || field.provenance.some((value) => !PROVENANCE.includes(value))) {
    throw new Error(`${toolId}${field.jsonPointer}: invalid provenance`);
  }
  if (!TRANSFER_POLICIES.includes(field.gatewayTransfer) || !['none', 'audit-metadata'].includes(field.retention)) {
    throw new Error(`${toolId}${field.jsonPointer}: invalid transfer/retention`);
  }
  if (field.maxBytes !== undefined && field.maxBytes !== null
      && (!Number.isSafeInteger(field.maxBytes) || field.maxBytes <= 0)) {
    throw new Error(`${toolId}${field.jsonPointer}: invalid maxBytes`);
  }
  const mayReachGateway = disposition === 'gateway-protected'
    && direction === 'input'
    && ['public-metadata', 'project-metadata'].includes(field.dataClass);
  if (field.gatewayTransfer === 'allowed' !== mayReachGateway) {
    throw new Error(`${toolId}${field.jsonPointer}: gateway transfer contradicts disposition/data class`);
  }
}

function assertExecutionSinkInventory(surfaceIds, toolById) {
  for (const sink of EXECUTION_SINKS) {
    const source = fs.readFileSync(path.join(ROOT, sink.file), 'utf8');
    if (!sink.pattern.test(source)) throw new Error(`${sink.surfaceId || sink.toolId}: expected sink signature drift`);
    if (sink.surfaceId && !surfaceIds.includes(sink.surfaceId)) throw new Error(`${sink.surfaceId}: unclassified execution sink`);
    if (sink.toolId && !sink.dispositions.includes(toolById.get(sink.toolId)?.disposition)) {
      throw new Error(`${sink.toolId}: unsafe execution sink disposition`);
    }
  }
}

async function main() {
  const urlIndex = process.argv.indexOf('--manual-url');
  const url = manualUrl(urlIndex >= 0 ? process.argv[urlIndex + 1] : null);
  await require('./project-connection').verifyConnection(require('./project-connection').selectConnection({ url }));
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const manual = await response.json();
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  if (ledger.schemaVersion !== 2 || ledger.toolCount !== manual.tools.length) {
    throw new Error('ledger schema/tool count drift');
  }
  const inventory = sourceInventory();
  const liveNames = manual.tools.map((tool) => tool.name).sort();
  const sourceNames = [...inventory.keys()].sort();
  const ledgerNames = ledger.tools.map((tool) => tool.toolId).sort();
  if (new Set(ledgerNames).size !== ledgerNames.length || !sameSet(liveNames, sourceNames) || !sameSet(liveNames, ledgerNames)) {
    throw new Error(JSON.stringify({ liveOnly: liveNames.filter((x) => !ledgerNames.includes(x)), ledgerOnly: ledgerNames.filter((x) => !liveNames.includes(x)), sourceOnly: sourceNames.filter((x) => !liveNames.includes(x)) }));
  }
  const liveByName = new Map(manual.tools.map((tool) => [tool.name, tool]));
  for (const row of ledger.tools) {
    if (row.sourceFile !== inventory.get(row.toolId)) throw new Error(`${row.toolId}: sourceFile drift`);
    if (!DISPOSITIONS.includes(row.disposition) || !row.reason) throw new Error(`${row.toolId}: invalid disposition/reason`);
    const liveFields = Object.keys(liveByName.get(row.toolId).inputs?.properties || {}).map((name) => `/${name}`).sort();
    const ledgerFields = row.inputFields.map((field) => field.jsonPointer).sort();
    if (!sameSet(liveFields, ledgerFields)) throw new Error(`${row.toolId}: input field drift`);
    for (const field of row.inputFields) assertDataFlow(row.toolId, field, 'input', row.disposition);
    if (!Array.isArray(row.outputFields)) throw new Error(`${row.toolId}: missing output policy`);
    if (!row.operationEffects || Object.keys(row.operationEffects).length === 0
        || Object.values(row.operationEffects).some((effect) => !['none', 'local-state', 'project-write', 'external-side-effect'].includes(effect))) {
      throw new Error(`${row.toolId}: invalid operation effects`);
    }
    if (row.disposition === 'gateway-protected') {
      if (row.gatewayResponsePolicy !== 'finite-contract-values-only') throw new Error(`${row.toolId}: unsafe Gateway response policy`);
      if (row.candidatePrimitives.length === 0) throw new Error(`${row.toolId}: missing primitive`);
      if (!row.observationContract || !ledger.observationContracts[row.observationContract]) throw new Error(`${row.toolId}: missing observation contract`);
      if (Object.values(row.operationEffects).some((effect) => effect !== 'none') && row.observationContract === 'none-v1') {
        throw new Error(`${row.toolId}: effectful operation missing precondition observation`);
      }
    } else if (row.gatewayResponsePolicy !== 'not-applicable') {
      throw new Error(`${row.toolId}: unexpected Gateway response policy`);
    }
  }
  const observationNames = Object.keys(ledger.observationContracts || {});
  for (const name of observationNames) {
    const contract = ledger.observationContracts[name];
    if (!contract.purpose || !contract.consentVersion || contract.retention !== 'none'
        || !Number.isSafeInteger(contract.maxBytes) || contract.maxBytes < 0 || !Array.isArray(contract.fields)) {
      throw new Error(`${name}: invalid observation contract`);
    }
  }
  const surfaces = ledger.auxiliarySurfaces || [];
  const surfaceIds = surfaces.map((surface) => surface.surfaceId).sort();
  if (new Set(surfaceIds).size !== surfaceIds.length || !sameSet(surfaceIds, [...REQUIRED_SURFACES].sort())) {
    throw new Error('auxiliary surface inventory drift');
  }
  for (const surface of surfaces) {
    if (!SURFACE_KINDS.includes(surface.kind) || !SURFACE_DISPOSITIONS.includes(surface.cutoverDisposition)
        || !surface.sourcePath || !surface.currentBehavior || !Array.isArray(surface.dataClasses)
        || surface.dataClasses.some((value) => !DATA_CLASSES.includes(value))) {
      throw new Error(`${surface.surfaceId}: invalid auxiliary surface policy`);
    }
  }
  const recordedRoutes = surfaces.flatMap((surface) => surface.currentRoutes || [])
    .filter((route) => !route.includes('{')).sort();
  if (!sameSet(literalRouteInventory(), recordedRoutes)) throw new Error('literal Express route inventory drift');
  const counts = ledger.tools.reduce((out, row) => ({ ...out, [row.disposition]: (out[row.disposition] || 0) + 1 }), {});
  assertExecutionSinkInventory(surfaceIds, new Map(ledger.tools.map((row) => [row.toolId, row])));
  console.log(JSON.stringify({ ok: true, toolCount: liveNames.length, surfaceCount: surfaces.length, counts }));
}

main().catch((error) => {
  console.error(`protected surface audit failed: ${error.message}`);
  process.exitCode = 1;
});
