#!/usr/bin/env node
'use strict';
const { fs, path, hash, stable, parseArgs } = require('./catalog-utils');
const { indexCatalog } = require('./index-catalog');

function classify(record) {
  if (record.internal === true || ['private', 'protected'].includes(record.visibility)) return ['catalog-only-internal', 'Internal or non-public declaration; no invocation permission.'];
  if (record.kind === 'event' || record.kind === 'broadcast') return ['event-only', 'Event metadata is not a request API.'];
  if (!Array.isArray(record.unresolved) || record.unresolved.length || !Array.isArray(record.signatures) || record.signatures.some(signature => !signature || typeof signature !== 'object' || !Array.isArray(signature.unresolved) || signature.unresolved.length)) return ['unresolved-type', 'Type completeness is unknown or unresolved; no callable DTO inferred.'];
  return ['declaration-only', 'Catalog evidence alone does not prove a reviewed adapter, context availability or qualification.'];
}

function generateLedger(catalogRoot, output) {
  const destination = path.resolve(output);
  const parent = fs.realpathSync(path.dirname(destination));
  const scratch = fs.mkdtempSync(path.join(parent, '.eligibility-'));
  try {
    const indexed = indexCatalog(catalogRoot, path.join(scratch, 'lookup'));
    const lookupBytes = fs.readFileSync(path.join(scratch, 'lookup', 'lookup.json'));
    if (hash(lookupBytes) !== indexed.lookupSha256) throw new Error('Generated lookup identity changed.');
    const lookup = JSON.parse(lookupBytes.toString('utf8'));
    const root = fs.realpathSync(catalogRoot);
    const rows = [];
    const keys = new Set();
    const counts = {};
    const sourceEvidence = [];
    for (const shard of lookup.shards) {
      const filename = path.join(root, shard.file);
      const real = fs.realpathSync(filename);
      const relative = path.relative(root, real);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Shard escapes catalog root.');
      const fd = fs.openSync(real, 'r');
      let bytes;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Shard exceeds ledger input bound.');
        const buffer = Buffer.allocUnsafe(stat.size + 1);
        let count = 0;
        while (count < buffer.length) {
          const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
          if (!read) break;
          count += read;
        }
        bytes = buffer.subarray(0, count);
        if (hash(bytes) !== shard.sha256) throw new Error('Shard no longer matches indexed bytes.');
      } finally { fs.closeSync(fd); }
      const document = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(document.records) || document.records.length !== shard.count) throw new Error('Shard count differs from indexed evidence.');
      sourceEvidence.push({ file: shard.file, sha256: shard.sha256, count: shard.count });
      for (const record of document.records) {
        if (typeof record.semanticKey !== 'string' || !record.semanticKey || record.version !== lookup.version) throw new Error('Record lacks versioned semantic identity.');
        const key = JSON.stringify([record.version, record.semanticKey]);
        if (keys.has(key)) throw new Error('Duplicate versioned semantic identity; no last-wins ledger.');
        keys.add(key);
        const [disposition, reason] = classify(record);
        counts[disposition] = (counts[disposition] || 0) + 1;
        rows.push({ key, recordId: record.id, semanticKey: record.semanticKey, version: record.version, domain: record.domain ?? null,
          workflowId: null, desiredOutcome: null, intendedContext: record.contextConstraints?.execution ?? null,
          sourceEvidence: { catalogHash: lookup.catalogHash, shard: shard.file, shardSha256: shard.sha256, source: record.source ?? null },
          existingBridgeTool: record.namespace === 'bridge' && record.kind === 'tool' ? record.member : null,
          operation: null, classification: disposition, chosenRoute: null, preflight: null, parametersDTO: null, resultDTO: null,
          limits: null, mutationScope: null, sourceHashGuard: null, historyContract: null, persistenceContract: null,
          rollbackContract: null, fixture: null, positiveID: null, negativeID: null, disposition, ownerDecision: null, reason,
          qualified: false, mutationAuthorized: false });
      }
    }
    if (rows.length !== indexed.recordCount) throw new Error('Ledger must account for every indexed record.');
    rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const ledger = { schemaVersion: 1, version: lookup.version, catalogHash: lookup.catalogHash,
      lookupSha256: indexed.lookupSha256, sourceIndexSha256: lookup.sourceIndexSha256, sourceEvidence,
      recordCount: rows.length, counts, selectionComplete: false, qualificationComplete: false, rows };
    const bytes = Buffer.from(JSON.stringify(stable({ ...ledger, ledgerHash: hash(ledger) })) + '\n');
    const fd = fs.openSync(destination, 'wx');
    try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    return { output: destination, recordCount: rows.length, counts, ledgerHash: hash(ledger) };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args, ['--catalog-root', '--output']);
  if (options.help) { console.log('Usage: node scripts/cocos-api/eligibility-ledger.js --catalog-root <catalog> --output <new-ledger.json>\nConservative all-record triage only; no selection, permission or qualification inferred.'); return; }
  if (!options['catalog-root'] || !options.output) throw new Error('--catalog-root and --output are required.');
  console.log(JSON.stringify(generateLedger(options['catalog-root'], options.output)));
}
if (require.main === module) { try { main(); } catch (error) { console.error(`eligibility-ledger: ${error.message}`); process.exitCode = 1; } }
module.exports = { classify, generateLedger, main };
