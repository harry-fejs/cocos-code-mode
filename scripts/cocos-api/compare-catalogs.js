#!/usr/bin/env node
'use strict';
const { path, compare, parseArgs, writeJson, hash } = require('./catalog-utils');
const { readCatalog } = require('./catalog-output');
const HELP = `Usage: node scripts/cocos-api/compare-catalogs.js --before <catalog-dir> --after <catalog-dir> --output <delta.json>
Joins version-independent semanticKey. Lines, paths, comments and source byte hashes do not produce API changes.
Categories: added, removed, signatureChanged, metadataChanged, unknownResolution.
`;
function compareCatalogs(before, after) {
  const older = new Map(before.records.map(record => [record.semanticKey, record]));
  const newer = new Map(after.records.map(record => [record.semanticKey, record]));
  if (older.size !== before.records.length || newer.size !== after.records.length) throw new Error('Catalog contains duplicate semantic identities.');
  const changes = [];
  for (const key of [...new Set([...older.keys(), ...newer.keys()])].sort(compare)) {
    const left = older.get(key);
    const right = newer.get(key);
    const base = { semanticKey: key, beforeId: left?.id || null, afterId: right?.id || null };
    if (!left) { changes.push({ ...base, kind: 'added' }); continue; }
    if (!right) { changes.push({ ...base, kind: 'removed' }); continue; }
    if (left.signatureHash !== right.signatureHash) changes.push({ ...base, kind: 'signatureChanged', before: left.signatures, after: right.signatures });
    if (left.metadataHash !== right.metadataHash) changes.push({ ...base, kind: 'metadataChanged', beforeHash: left.metadataHash, afterHash: right.metadataHash });
    if (left.resolutionHash !== right.resolutionHash) changes.push({ ...base, kind: 'unknownResolution', before: left.unresolved || [], after: right.unresolved || [] });
  }
  const counts = Object.fromEntries(['added', 'removed', 'signatureChanged', 'metadataChanged', 'unknownResolution'].map(kind => [kind, changes.filter(change => change.kind === kind).length]));
  const result = { schemaVersion: 1, before: { version: before.index.version, catalogHash: before.index.catalogHash },
    after: { version: after.index.version, catalogHash: after.index.catalogHash }, counts, changes };
  return { ...result, deltaHash: hash(result) };
}
function main(args = process.argv.slice(2)) {
  const options = parseArgs(args, ['--before', '--after', '--output']);
  if (options.help) { console.log(HELP); return; }
  if (!options.before || !options.after || !options.output) throw new Error('--before, --after, --output are required.');
  const delta = compareCatalogs(readCatalog(options.before), readCatalog(options.after));
  writeJson(path.resolve(options.output), delta);
  console.log(JSON.stringify({ output: path.resolve(options.output), deltaHash: delta.deltaHash, counts: delta.counts }));
  return delta;
}
if (require.main === module) { try { main(); } catch (error) { console.error(`catalog-delta: ${error.message}`); process.exitCode = 1; } }
module.exports = { compareCatalogs, main };
