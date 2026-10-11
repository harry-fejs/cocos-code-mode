#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { digest, semanticBasis } = require('./generate-workflow-coverage');

function audit(root = path.resolve(__dirname, '..'), requireFrozen = false) {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const inventory = read('docs/workflow-inventory.json');
  const mapping = read('docs/workflow-source-mapping.json');
  const evidence = read('docs/workflow-implementation-evidence.json');
  const coverage = read('reports/workflow-coverage-report.json');
  const backlog = read('reports/workflow-closure-backlog.json');
  const reviews = read('docs/workflow-contract-reviews.json');
  const competitor = read('reports/original-competitor-intake-20260917.json');
  const lanes = read('reports/original-lane-requirements-20260917.json');
  const fail = message => { throw new Error(message); };
  const expected = new Set([
    ...competitor.rows.map(row => `${row.catalog === 'Funplay' ? 'funplay' : 'cocos-mcp'}:${row.name}`),
    ...lanes.rows.map(row => `lane:${row.source.replace('/plan.md', '')}:${row.name}`),
    ...['runtime-session', 'runtime-input', 'runtime-capture', 'runtime-observation', 'compound-scene', 'mutation-workflow', 'long-job', 'golden-tracer'].map(id => `parent:${id}`),
  ]);
  const unique = (values, label) => { if (new Set(values).size !== values.length) fail(`duplicate ${label}`); };
  const overrides = read('docs/workflow-implementation-overrides.json');
  if (!Array.isArray(overrides.rows)) fail('implementation overrides must contain rows');
  const overrideIds = overrides.rows.map(row => row.workflowId);
  unique(overrideIds, 'implementation overrides');
  const inventoryIds = new Set(inventory.rows.map(row => row.id));
  const overrideStates = ['complete', 'test-pending', 'partial', 'missing', 'unsupported', 'external', 'unreviewed', 'excluded'];
  for (const override of overrides.rows) {
    if (!inventoryIds.has(override.workflowId)) fail(`unknown implementation override workflow: ${override.workflowId}`);
    if (!overrideStates.includes(override.state) || typeof override.reason !== 'string' || !override.reason.trim()) fail(`invalid implementation override: ${override.workflowId}`);
    if (!Array.isArray(override.routes) || !Array.isArray(override.evidenceArtifacts) || !Array.isArray(override.limitations)) fail(`invalid implementation override shape: ${override.workflowId}`);
    if (override.state === 'complete' && (!override.routes.length || !override.evidenceArtifacts.length)) fail(`incomplete complete override: ${override.workflowId}`);
    for (const route of override.routes) if (!route?.file || !fs.existsSync(path.join(root, route.file))) fail(`missing override route: ${override.workflowId}`);
    for (const artifact of override.evidenceArtifacts) { const file = typeof artifact === 'string' ? artifact.split('#')[0] : artifact?.path; if (!file || !fs.existsSync(path.join(root, file))) fail(`missing override evidence: ${override.workflowId}`); }
  }
  unique(inventory.rows.map(row => row.id), 'workflow IDs');
  unique(mapping.rows.map(row => row.sourceId), 'source mappings');
  unique(reviews.rows.map(row => row.sourceId), 'contract reviews');
  if (mapping.rows.length !== expected.size || mapping.rows.some(row => !expected.has(row.sourceId))) fail('source inventory mismatch');
  for (const [file, hash] of Object.entries(inventory.inputHashes)) {
    if (digest(fs.readFileSync(path.join(root, file))) !== hash) fail(`stale input hash: ${file}`);
  }
  if (inventory.denominatorInputHashes) {
    const bySource = new Map(mapping.rows.map(row => [row.sourceId, row]));
    const basis = {
      profile: inventory.qualificationProfile,
      sourceHashes: inventory.denominatorInputHashes,
      mappings: [...expected].map(sourceId => ({ sourceId, workflowId: bySource.get(sourceId).workflowId })),
      dispositions: inventory.rows.map(({ id, denominatorDisposition }) => ({ id, denominatorDisposition })),
    };
    if (digest(JSON.stringify(basis)) !== inventory.denominatorHash) fail('historical denominator input-hash basis drift');
    if (digest(JSON.stringify(semanticBasis(inventory.rows, mapping.rows))) !== inventory.denominatorSemanticHash) fail('frozen denominator semantic identity drift');
  }
  if (evidence.implementationOverrideHash && evidence.implementationOverrideHash !== digest(fs.readFileSync(path.join(root, 'docs/workflow-implementation-overrides.json')))) fail('implementation override hash drift');
  for (const item of [mapping, evidence, coverage, backlog]) {
    if (item.denominatorVersion !== inventory.denominatorVersion || item.denominatorHash !== inventory.denominatorHash) fail('denominator identity drift');
    if (item.denominatorIdentityKind !== inventory.denominatorIdentityKind || item.denominatorSemanticHash !== inventory.denominatorSemanticHash) fail('denominator semantic provenance drift');
  }
  const byId = new Map(inventory.rows.map(row => [row.id, row]));
  const states = ['complete', 'test-pending', 'partial', 'missing', 'unsupported', 'external', 'unreviewed', 'excluded'];
  for (const row of inventory.rows) {
    if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(row.id) || !states.includes(row.implementationState)) fail(`invalid workflow: ${row.id}`);
    if (!row.observableOutcome || !row.executionContext || !row.sourceIds.length) fail(`incomplete contract: ${row.id}`);
    const actual = mapping.rows.filter(item => item.workflowId === row.id).map(item => item.sourceId).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...row.sourceIds].sort())) fail(`reverse mapping mismatch: ${row.id}`);
    if (row.denominatorDisposition !== 'included' && row.denominatorDisposition !== 'excluded') fail(`invalid disposition: ${row.id}`);
    if (row.denominatorDisposition === 'excluded' && (!row.approval?.instruction || !row.approval?.date)) fail(`unapproved exclusion: ${row.id}`);
    if (row.sourceIds.length > 1 && !row.mergeEvidence.length) fail(`unproved merge: ${row.id}`);
    if (row.implementationState === 'complete' || row.implementationState === 'test-pending') {
      if (!row.reviewed || !row.implementationRoute.length || !row.evidenceArtifacts.length) fail(`unproven implementation: ${row.id}`);
      for (const route of row.implementationRoute) if (!fs.existsSync(path.join(root, route.file))) fail(`missing source: ${route.file}`);
      for (const artifact of row.evidenceArtifacts) {
        const file = typeof artifact === 'string' ? artifact.split('#')[0] : artifact.path;
        if (!file || !fs.existsSync(path.join(root, file))) fail(`missing evidence: ${row.id}`);
      }
    }
  }
  if (mapping.rows.some(row => !byId.has(row.workflowId))) fail('unknown mapped workflow');
  const unresolved = mapping.rows.filter(row => row.status !== 'contract-reviewed').length;
  const included = inventory.rows.filter(row => row.denominatorDisposition === 'included');
  const complete = included.filter(row => row.implementationState === 'complete').length;
  if (coverage.unresolvedContracts !== unresolved || coverage.candidateDenominator !== included.length || coverage.confirmedComplete !== complete) fail('coverage count drift');
  if (unresolved) {
    if (coverage.implementationPercent !== null || coverage.deficitTo90 !== null || coverage.denominator !== null) fail('unreviewed coverage must not claim an exact score');
  } else {
    if (coverage.denominator !== included.length || coverage.implementationPercent !== Number((complete * 100 / included.length).toFixed(2))) fail('coverage arithmetic drift');
  }
  if (evidence.rows.length !== inventory.rows.length || new Set(evidence.rows.map(row => row.workflowId)).size !== inventory.rows.length) fail('evidence inventory mismatch');
  if (backlog.rows.some(row => !byId.has(row.workflowId))) fail('unknown backlog workflow');
  if (requireFrozen && (unresolved || inventory.status !== 'frozen-v1')) fail('denominator not frozen: complete contract review and owner acceptance first');
  return { ok: true, freezeEligible: unresolved === 0, frozen: inventory.status === 'frozen-v1', sources: expected.size, workflows: inventory.rows.length, unresolvedContracts: unresolved, implementationPercent: coverage.implementationPercent, approvedHistoricalDenominatorHash: inventory.denominatorHash, currentDenominatorSemanticHash: inventory.denominatorSemanticHash };
}
module.exports = { audit };
if (require.main === module) { try { console.log(JSON.stringify(audit(undefined, process.argv.includes('--require-frozen')))); } catch (error) { console.error(error.message); process.exitCode = 1; } }
