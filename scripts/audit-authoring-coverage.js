#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { classify, makeBasis, digest, INPUTS, OUTPUTS, PARENT_FULL_DENOMINATOR_HASH, APPROVED_AUTHORING_DENOMINATOR_HASH, APPROVED_AUTHORING_SEMANTIC_HASH } = require('./generate-authoring-coverage');

const ROOT = path.resolve(__dirname, '..');
const fail = message => { throw new Error(message); };
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const stableJson = value => JSON.stringify(value);
function audit(root = ROOT) {
  const full = read(root, 'docs/workflow-inventory.json');
  const authoring = read(root, OUTPUTS.inventory);
  const coverage = read(root, OUTPUTS.coverage);
  const backlog = read(root, OUTPUTS.backlog);
  if (full.denominatorHash !== PARENT_FULL_DENOMINATOR_HASH) fail('full denominator hash drift');
  if (full.rows.length !== 356) fail(`full inventory must contain 356 rows, got ${full.rows.length}`);
  for (const artifact of [authoring, coverage, backlog]) {
    if (artifact.parentFullDenominatorHash !== PARENT_FULL_DENOMINATOR_HASH) fail('parentFullDenominatorHash drift');
    if (!artifact.denominatorHash || !/^[a-f0-9]{64}$/.test(artifact.denominatorHash)) fail('missing or malformed authoring denominator hash');
    if (artifact.denominatorVersion !== authoring.denominatorVersion) fail('authoring denominator version drift');
    if (artifact.denominatorIdentityKind !== 'approved-historical' || artifact.denominatorHash !== APPROVED_AUTHORING_DENOMINATOR_HASH) fail('approved historical authoring identity drift');
  }
  const sourceHashes = Object.fromEntries(INPUTS.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  for (const artifact of [authoring, coverage, backlog]) {
    for (const [file, hash] of Object.entries(sourceHashes)) {
      if (artifact.sourceHashes?.[file] !== hash) fail(`source hash drift: ${file}`);
    }
    if (artifact.sourceInventoryHash !== sourceHashes['docs/workflow-inventory.json']) fail('source inventory hash drift');
  }
  const fullById = new Map(full.rows.map(row => [row.id, row]));
  const rows = authoring.rows;
  if (!Array.isArray(rows) || rows.length !== full.rows.length) fail('authoring classification row count mismatch');
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail('duplicate authoring workflow IDs');
  if (new Set(fullById.keys()).size !== full.rows.length) fail('duplicate full workflow IDs');
  for (const row of rows) {
    const original = fullById.get(row.id);
    if (!original) fail(`unknown authoring workflow ID: ${row.id}`);
    if (row.authoringDisposition !== 'included' && row.authoringDisposition !== 'deferred') fail(`invalid classification: ${row.id}`);
    if (!row.authoringReason) fail(`missing classification reason: ${row.id}`);
    const expected = classify(original);
    if (row.authoringDisposition !== expected.disposition || row.authoringReason !== expected.reason) fail(`classification drift: ${row.id}`);
    if (row.implementationState !== original.implementationState) fail(`implementation state drift: ${row.id}`);
  }
  for (const id of fullById.keys()) if (!rows.some(row => row.id === id)) fail(`missing classification: ${id}`);
  const included = rows.filter(row => row.authoringDisposition === 'included');
  const deferred = rows.filter(row => row.authoringDisposition === 'deferred');
  const complete = included.filter(row => row.implementationState === 'complete');
  const target = Math.ceil(included.length * 0.9);
  const percent = included.length ? Number((complete.length * 100 / included.length).toFixed(2)) : 0;
  if (coverage.totalSourceRows !== rows.length || coverage.includedAuthoringRows !== included.length || coverage.deferredRows !== deferred.length) fail('coverage count mismatch');
  if (coverage.denominator !== included.length || coverage.confirmedComplete !== complete.length) fail('coverage denominator arithmetic mismatch');
  if (coverage.targetComplete !== target || coverage.deficitTo90 !== Math.max(0, target - complete.length) || coverage.implementationPercent !== percent) fail('coverage target arithmetic mismatch');
  const expectedBacklog = included.filter(row => row.implementationState !== 'complete').map(row => row.id).sort();
  const actualBacklog = (backlog.rows || []).map(row => row.workflowId).sort();
  if (stableJson(expectedBacklog) !== stableJson(actualBacklog)) fail('closure backlog mismatch');
  if (backlog.requiredFor90 !== Math.max(0, target - complete.length)) fail('backlog deficit mismatch');
  const basis = makeBasis(rows);
  const expectedHash = digest(stableJson(basis));
  if (expectedHash !== APPROVED_AUTHORING_SEMANTIC_HASH || [authoring, coverage, backlog].some(artifact => artifact.denominatorSemanticHash !== expectedHash)) fail('current authoring semantic hash mismatch');
  const metrics = { total: rows.length, included: included.length, deferred: deferred.length, complete: complete.length, targetComplete: target, deficit: Math.max(0, target - complete.length), implementationPercent: percent, approvedHistoricalDenominatorHash: APPROVED_AUTHORING_DENOMINATOR_HASH, currentDenominatorSemanticHash: expectedHash };
  return { ok: true, metrics };
}

module.exports = { audit };
if (require.main === module) {
  try { console.log(JSON.stringify(audit(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
