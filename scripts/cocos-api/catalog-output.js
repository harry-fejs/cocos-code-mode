'use strict';
const { fs, path, compare, json, hash, semantic, finalize, writeJson, boundedInteger } = require('./catalog-utils');
const PILOTS = new Set(['Button', 'Label', 'Sprite', 'Layout', 'Widget', 'ScrollView', 'Camera']);
function writeCatalog(output, version, records, extras = {}, options = {}) {
  const limit = boundedInteger(options.shardSize, 200, 1, 2000, 'shard-size');
  const maxBytes = boundedInteger(options.shardBytes, 2097152, 32768, 16777216, 'shard-bytes');
  const directory = path.resolve(output);
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error(`Output must be a fresh empty directory: ${directory}`);
  if (!records.length) throw new Error('No catalog records extracted; refusing an empty success catalog.');
  const sorted = records.map(finalize).sort((a, b) => compare(a.id, b.id));
  const identities = new Set();
  for (const record of sorted) {
    if (identities.has(record.id)) throw new Error(`Duplicate catalog identity: ${record.id}`);
    identities.add(record.id);
  }
  const groups = new Map();
  for (const record of sorted) {
    const domain = `${record.namespace}.${record.domain || record.module.replace(/[^\w-]/g, '-')}`;
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(record);
  }
  const semanticRoutes = [...new Map((extras.routes || []).map(route => {
    const projected = semantic(route);
    return [json(projected), projected];
  })).entries()].sort(([a], [b]) => compare(a, b)).map(([, route]) => route);
  const catalogHash = hash({ schemaVersion: 1, version, records: sorted.map(semantic), routes: semanticRoutes });
  const domains = [];
  for (const [name, entries] of [...groups.entries()].sort(([a], [b]) => compare(a, b))) {
    let chunk = [];
    let page = 0;
    const flush = () => {
      const file = `${name.replace(/[^a-zA-Z0-9_.-]/g, '-')}.${String(++page).padStart(4, '0')}.json`;
      writeJson(path.join(directory, file), { records: chunk });
      domains.push({ name, file, count: chunk.length });
      chunk = [];
    };
    for (const record of entries) {
      if (Buffer.byteLength(JSON.stringify({ records: [record] }, null, 2), 'utf8') > maxBytes) throw new Error(`Record ${record.id} exceeds shard-bytes ${maxBytes}; nothing is truncated.`);
      if (chunk.length && (chunk.length >= limit || Buffer.byteLength(JSON.stringify({ records: [...chunk, record] }, null, 2), 'utf8') > maxBytes)) flush();
      chunk.push(record);
    }
    if (chunk.length) flush();
  }
  const unknowns = [...sorted.flatMap(record => (record.unresolved || []).map(item => ({ recordId: record.id, ...item }))), ...(extras.unknowns || [])].sort((a, b) => compare(json(a), json(b)));
  const unresolved = [...new Map(unknowns.map(item => [json(item), item])).values()];
  const index = { schemaVersion: 1, version, catalogHash, domains, unresolvedCount: unresolved.length };
  writeJson(path.join(directory, 'unresolved.json'), { schemaVersion: 1, version, catalogHash, unresolved, diagnostics: extras.diagnostics || [] });
  if (extras.routes) writeJson(path.join(directory, 'bridge-routes.json'), { schemaVersion: 1, version, catalogHash, routes: extras.routes, qualification: 'static-composition-only' });
  writeJson(path.join(directory, 'provenance.json'), { schemaVersion: 1, version, catalogHash, ...extras.provenance, originalCatalogHash: options.originalCatalogHash || null,
    extraction: { compiler: 'typescript', noEmit: true, executedSource: false, shardSize: limit, shardBytes: maxBytes } });
  writeJson(path.join(directory, 'index.json'), index);
  return index;
}
function writePilot(output, version, records, originalCatalogHash, options = {}) {
  const selected = records.filter(record => record.namespace === 'engine-runtime' && record.module === 'cc' && PILOTS.has(record.className) && record.publicExport && !record.internal && record.visibility === 'public').map(record => {
    const { jsdoc, declarationEvidence, ...pilot } = record;
    return { ...pilot, omittedMetadata: ['jsdoc', 'declarationEvidence'],
      declarationSummary: declarationEvidence ? { source: declarationEvidence.source, agreement: declarationEvidence.agreement, provenance: declarationEvidence.provenance } : null };
  });
  for (const pilot of PILOTS) if (!selected.some(record => record.className === pilot && record.kind === 'class')) throw new Error(`Pilot class is missing from source export closure: ${pilot}`);
  const size = selected.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record), 'utf8'), 0);
  if (size > 4 * 1024 * 1024) throw new Error('Pilot metadata exceeds the 4MiB per-version shipping limit.');
  return writeCatalog(output, version, selected, { provenance: { scope: 'reviewed-seven-class-read-only-pilot', classes: [...PILOTS].sort(compare) } }, { ...options, originalCatalogHash });
}
function readCatalog(directory) {
  const root = path.resolve(directory);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  if (index.schemaVersion !== 1 || !Array.isArray(index.domains)) throw new Error(`Unsupported catalog index: ${root}`);
  const records = [];
  for (const domain of index.domains) {
    if (typeof domain.file !== 'string' || path.basename(domain.file) !== domain.file || !/\.json$/.test(domain.file)) throw new Error('Invalid catalog shard path.');
    const shard = JSON.parse(fs.readFileSync(path.join(root, domain.file), 'utf8'));
    if (!Array.isArray(shard.records) || shard.records.length !== domain.count) throw new Error(`Invalid shard record count: ${domain.file}`);
    records.push(...shard.records);
  }
  return { index, records };
}
module.exports = { writeCatalog, writePilot, readCatalog };
