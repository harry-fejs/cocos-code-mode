#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const PARENT_FULL_DENOMINATOR_HASH = '9dd249158a8826bff1ba4021147302a7f34a60a84430344a5b4330053d517286';
// This approved historical identifier predates byte-level provenance repair.
// The separate semantic hash binds the exact unchanged current classifications.
const APPROVED_AUTHORING_DENOMINATOR_HASH = '0c5a2efbb78ac590f1b69731822f19f51e20de206148844bdaaa593cc1a3e9e6';
const APPROVED_AUTHORING_SEMANTIC_HASH = 'f704714bffb7580ff3e018ea289c15995e1cbba39a4117633030b0f00cf03468';
const VERSION = 'ccp3x-creator-3.7.3-windows-v1-authoring-first';
const INPUTS = [
  'docs/workflow-inventory.json',
  'docs/workflow-source-mapping.json',
  'docs/workflow-implementation-evidence.json',
  'reports/workflow-coverage-report.json',
  'reports/workflow-closure-backlog.json',
];
const OUTPUTS = {
  inventory: 'docs/authoring-first-workflow-inventory.json',
  coverage: 'reports/authoring-first-workflow-coverage-report.json',
  backlog: 'reports/authoring-first-workflow-closure-backlog.json',
};

const AUTHORING_DOMAINS = new Set([
  'scene', 'editor', 'design-prefab', 'prefab', 'animation', 'animation-graph',
  'skeletal-animation', 'assets-import', 'asset', 'ui-layout', 'tilemap-atlas',
  'rendering-materials', 'terrain-model', 'physics-2d', 'physics-3d', 'particles', 'audio',
]);

// These phrases identify a contract whose acceptance depends on an active runtime,
// Game View/preview playback, or delivery outside the editor authoring surface.
const EXPLICIT_RUNTIME = [
  /runtime[- ]session/i,
  /named runtime/i,
  /actual runtime/i,
  /runtime (?:state|load|release|raycast|sweep|contact|trigger|query|target|source)/i,
  /game view/i,
  /launched artifact/i,
  /launch (?:the )?(?:exact )?produced artifact/i,
  /browser|terminal|device|web artifact|verified url/i,
  /playback/i,
  /\bplay(?:ing|back)?\b/i,
  /run graph and observe/i,
  /preview game|preview (?:window|server)/i,
  /runtime restart/i,
  /runtime extension support/i,
  /runtime-only/i,
];

const stableJson = value => JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = (root, file) => digest(fs.readFileSync(path.join(root, file)));
const writeJson = (root, file, value) => fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);

function classify(row) {
  const text = [row.domain, row.executionContext, row.title, row.observableOutcome].join('\n');
  const runtimeMatch = EXPLICIT_RUNTIME.find(pattern => pattern.test(text));
  if (!AUTHORING_DOMAINS.has(row.domain)) {
    return { disposition: 'deferred', reason: `Deferred from authoring denominator: domain ${row.domain} is runtime, delivery, diagnostics, build, localization, product, or other non-authoring scope.` };
  }
  if (row.executionContext === 'runtime') {
    return { disposition: 'deferred', reason: 'Deferred from authoring denominator: executionContext=runtime requires an active runtime target.' };
  }
  if (runtimeMatch) {
    return { disposition: 'deferred', reason: `Deferred from authoring denominator: contract requires runtime/playback/preview or external delivery (${runtimeMatch}).` };
  }
  return { disposition: 'included', reason: `Included authoring contract: ${row.domain} is an editor-side authoring domain and the contract has no active-runtime or external-delivery prerequisite.` };
}

function makeBasis(rows) {
  return {
    profile: { creator: '3.7.3', os: 'windows-x64', profile: 'authoring-first', artifactClass: 'local-operator' },
    parentFullDenominatorHash: PARENT_FULL_DENOMINATOR_HASH,
    classifications: rows.map(row => ({
      id: row.id,
      domain: row.domain,
      executionContext: row.executionContext,
      title: row.title,
      observableOutcome: row.observableOutcome,
      disposition: row.authoringDisposition,
      reason: row.authoringReason,
    })),
  };
}

function generate(root = ROOT) {
  const sourceBytes = Object.fromEntries(INPUTS.map(file => [file, fs.readFileSync(path.join(root, file))]));
  const source = JSON.parse(sourceBytes[INPUTS[0]]);
  const sourceHashes = Object.fromEntries(INPUTS.map(file => [file, digest(sourceBytes[file])]));
  if (source.denominatorHash !== PARENT_FULL_DENOMINATOR_HASH) throw new Error(`unexpected parent denominator hash: ${source.denominatorHash}`);
  if (!Array.isArray(source.rows) || source.rows.length !== 356) throw new Error(`expected 356 full rows, got ${source.rows?.length}`);
  const rows = source.rows.map(row => {
    const classification = classify(row);
    return {
      id: row.id,
      domain: row.domain,
      title: row.title,
      observableOutcome: row.observableOutcome,
      executionContext: row.executionContext,
      sourceIds: row.sourceIds,
      implementationState: row.implementationState,
      implementationReason: row.implementationReason,
      limitations: row.limitations || [],
      authoringDisposition: classification.disposition,
      authoringReason: classification.reason,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('duplicate workflow IDs in source inventory');
  const basis = makeBasis(rows);
  const denominatorSemanticHash = digest(stableJson(basis));
  if (denominatorSemanticHash !== APPROVED_AUTHORING_SEMANTIC_HASH) throw new Error('Approved authoring classifications changed; explicit denominator re-approval is required.');
  const previousFile = path.join(root, OUTPUTS.inventory);
  if (fs.existsSync(previousFile)) {
    const previous = JSON.parse(fs.readFileSync(previousFile, 'utf8'));
    if (previous.denominatorVersion !== VERSION || previous.parentFullDenominatorHash !== PARENT_FULL_DENOMINATOR_HASH
        || stableJson(makeBasis(previous.rows)) !== stableJson(basis)) {
      throw new Error('Existing authoring contract/classification basis changed; explicit denominator re-approval is required.');
    }
  }
  const denominatorHash = APPROVED_AUTHORING_DENOMINATOR_HASH;
  const included = rows.filter(row => row.authoringDisposition === 'included');
  const deferred = rows.filter(row => row.authoringDisposition === 'deferred');
  const complete = included.filter(row => row.implementationState === 'complete');
  const targetComplete = Math.ceil(included.length * 0.9);
  const byDomain = {};
  for (const row of rows) {
    const bucket = byDomain[row.domain] ||= { total: 0, included: 0, deferred: 0, complete: 0, implementationPercent: 0 };
    bucket.total++;
    if (row.authoringDisposition === 'included') {
      bucket.included++;
      if (row.implementationState === 'complete') bucket.complete++;
    } else bucket.deferred++;
  }
  for (const bucket of Object.values(byDomain)) {
    bucket.implementationPercent = bucket.included ? Number((bucket.complete * 100 / bucket.included).toFixed(2)) : null;
    bucket.targetComplete = Math.ceil(bucket.included * 0.9);
    bucket.deficit = Math.max(0, bucket.targetComplete - bucket.complete);
  }
  const common = {
    schemaVersion: 1,
    denominatorVersion: VERSION,
    denominatorHash,
    denominatorIdentityKind: 'approved-historical',
    denominatorSemanticHash,
    parentFullDenominatorHash: PARENT_FULL_DENOMINATOR_HASH,
    sourceInventoryHash: sourceHashes['docs/workflow-inventory.json'],
    sourceHashes,
  };
  const inventory = {
    ...common,
    status: 'generated',
    qualificationProfile: basis.profile,
    classificationRules: {
      includedDomains: [...AUTHORING_DOMAINS].sort(),
      deferredDomains: ['build', 'build-platform', 'diagnostics', 'localization', 'product', 'runtime', 'runtime-qa', 'other'],
      runtimeSignals: EXPLICIT_RUNTIME.map(pattern => String(pattern)),
      completeCredit: 'Only rows with authoringDisposition=included and implementationState=complete count toward authoring coverage.',
    },
    counts: { total: rows.length, included: included.length, deferred: deferred.length },
    rows,
  };
  const coverage = {
    ...common,
    status: 'measurable',
    totalSourceRows: rows.length,
    includedAuthoringRows: included.length,
    deferredRows: deferred.length,
    denominator: included.length,
    confirmedComplete: complete.length,
    implementationPercent: included.length ? Number((complete.length * 100 / included.length).toFixed(2)) : 0,
    targetPercent: 90,
    targetComplete,
    deficitTo90: Math.max(0, targetComplete - complete.length),
    byDomain,
    deferredReasonSummary: 'Deferred rows remain fully traceable in the authoring inventory but are excluded from the authoring denominator and cannot receive complete credit.',
  };
  const backlog = {
    ...common,
    status: 'ready-for-authoring-implementation-reconciliation',
    requiredFor90: Math.max(0, targetComplete - complete.length),
    rows: included.filter(row => row.implementationState !== 'complete').map(row => ({
      workflowId: row.id,
      domain: row.domain,
      state: row.implementationState,
      reason: row.implementationReason,
      acceptance: row.observableOutcome,
      limitations: row.limitations,
    })),
  };
  writeJson(root, OUTPUTS.inventory, inventory);
  writeJson(root, OUTPUTS.coverage, coverage);
  writeJson(root, OUTPUTS.backlog, backlog);
  return {
    ok: true,
    totalSourceRows: rows.length,
    included: included.length,
    deferred: deferred.length,
    complete: complete.length,
    targetComplete,
    deficit: Math.max(0, targetComplete - complete.length),
    approvedHistoricalDenominatorHash: denominatorHash,
    currentDenominatorSemanticHash: denominatorSemanticHash,
    byDomain,
  };
}

module.exports = { generate, classify, makeBasis, digest, INPUTS, OUTPUTS, PARENT_FULL_DENOMINATOR_HASH, APPROVED_AUTHORING_DENOMINATOR_HASH, APPROVED_AUTHORING_SEMANTIC_HASH };
if (require.main === module) {
  try { console.log(JSON.stringify(generate(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
