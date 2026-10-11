'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const slash = value => value.replace(/\\/g, '/');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sourceHashes = new WeakMap();
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(compare).filter(k => value[k] !== undefined).map(k => [k, stable(value[k])]));
  return value;
}
const json = value => JSON.stringify(stable(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value)).digest('hex');
function tokens(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const parts = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) parts.push([kind, scanner.getTokenText()]);
  return json(parts);
}
function text(node) { return node ? ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()).trim() : null; }
function files(root, accept, maxFiles = 30000) {
  const result = [];
  if (!fs.existsSync(root)) throw new Error(`Input does not exist: ${root}`);
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', '.git', 'dist', 'bin', 'tests', 'test'].includes(entry.name)) walk(file); }
      else if (accept(file)) { result.push(file); if (result.length > maxFiles) throw new Error(`Input exceeds ${maxFiles} files: ${root}`); }
    }
  };
  if (fs.statSync(root).isFile()) return accept(root) ? [path.resolve(root)] : [];
  walk(root);
  return result;
}
function source(node, root, label) {
  const sf = node.getSourceFile();
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  if (!sourceHashes.has(sf)) sourceHashes.set(sf, hash(sf.text));
  return { root: label, path: slash(path.relative(root, sf.fileName)), line: start.line + 1,
    endLine: sf.getLineAndCharacterOfPosition(node.end).line + 1, sha256: sourceHashes.get(sf), semanticHash: hash(tokens(text(node) || '')) };
}
function semanticValue(value) {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['source', 'jsdoc', 'evidence', 'declarationEvidence', 'exportedFrom', 'path', 'line', 'endLine', 'sha256', 'semanticHash', 'signatureId', 'recordId', 'text'].includes(key))
    .map(([key, nested]) => [key, semanticValue(nested)]));
  return value;
}
function semantic(record) {
  const { id, version, source: origin, evidence, jsdoc, declarationEvidence, exportedFrom, ...rest } = record;
  const { signatureHash, metadataHash, resolutionHash, ...contract } = rest;
  return semanticValue(contract);
}
function finalize(record) {
  record.semanticKey = json([record.namespace, record.module, record.className || '', record.member || '', record.kind, !!record.static]);
  record.id = `${record.version}:${record.namespace}:${encodeURIComponent(record.module)}:${encodeURIComponent(record.className || '')}:${encodeURIComponent(record.member || '')}:${record.kind}:${record.static ? 'static' : 'instance'}`;
  record.signatures = record.signatures.map((signature, index) => {
    const { signatureId, ...rest } = signature;
    return { ...rest, signatureId: `${record.id}:overload:${index}:${hash(semanticValue(rest)).slice(0, 16)}` };
  });
  record.signatureHash = hash(semanticValue(record.signatures.map(({ unresolved, text: display, ...signature }) => signature)));
  record.resolutionHash = hash(semanticValue(record.unresolved || []));
  const projected = semantic(record);
  delete projected.signatures;
  delete projected.unresolved;
  delete projected.evidenceStatus;
  delete projected.composedRouteCount;
  record.metadataHash = hash(projected);
  return record;
}
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(stable(value), null, 2) + '\n', 'utf8'); }
function parseArgs(args, allowed) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') { options.help = true; continue; }
    if (!allowed.includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument ${key}; use --help.`);
    if (options[key.slice(2)] !== undefined) throw new Error(`Duplicate argument: ${key}`);
    options[key.slice(2)] = args[++i];
  }
  return options;
}
function boundedInteger(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return number;
}
module.exports = { ts, fs, path, slash, compare, stable, json, hash, tokens, text, files, source, semantic, semanticValue, finalize, writeJson, parseArgs, boundedInteger };
