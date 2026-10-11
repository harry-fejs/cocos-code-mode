#!/usr/bin/env node
'use strict';
const { fs, path, hash, parseArgs, boundedInteger } = require('./catalog-utils');
const { engineInputs, diagnosticRow } = require('./compiler-inputs');
const { extractEngine, extractDeclarations, attachDeclarations } = require('./engine-records');
const { extractEditor } = require('./editor-records');
const { extractBridge } = require('./bridge-routes');
const { writeCatalog, writePilot } = require('./catalog-output');
const HELP = `Offline Cocos API catalog (never executes engine/editor source)
Usage: node scripts/cocos-api/extract-catalog.js --version <version> --output <empty-directory>
  --engine-root <snapshot>       Engine exports + editor/exports (required for engine/all)
  --declarations-root <path>     Explicit matching-version declaration file/directory (optional)
  --declarations-version <v>     Required with declarations; must equal --version
  --editor-root <app.asar.unpacked> Matching Creator registry/facades (optional)
  --bridge-root <extension>      Composed @utcpTool handler/IPC/scene route map (required for bridge)
  --kind <all|engine|bridge>     Default all; bridge catalog is distinct namespace
  --pilot-output <empty-dir>    Optional seven-class runtime metadata, independent catalog hash
  --shard-size <1..2000>        Default 200 records per shard
  --shard-bytes <32768..16777216> Default 2097152 UTF-8 bytes per complete shard
`;
function parseOptions(args) {
  const parsed = parseArgs(args, ['--version', '--output', '--engine-root', '--declarations-root', '--declarations-version', '--editor-root', '--bridge-root', '--kind', '--pilot-output', '--shard-size', '--shard-bytes']);
  if (parsed.help) return parsed;
  if (!parsed.version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(parsed.version)) throw new Error('--version requires an explicit semantic version.');
  if (!parsed.output) throw new Error('--output is required; no implicit repository output.');
  const kind = parsed.kind || 'all';
  if (!['all', 'engine', 'bridge'].includes(kind)) throw new Error('--kind must be all, engine, or bridge.');
  if (kind !== 'bridge' && !parsed['engine-root']) throw new Error('--engine-root is required for engine/all catalogs.');
  if (kind === 'bridge' && !parsed['bridge-root']) throw new Error('--bridge-root is required for bridge catalogs.');
  if (parsed['declarations-root'] && parsed['declarations-version'] !== parsed.version) throw new Error('--declarations-version must explicitly match --version.');
  if (kind === 'bridge' && parsed['pilot-output']) throw new Error('A bridge catalog cannot emit an engine pilot.');
  return { version: parsed.version, output: path.resolve(parsed.output), kind,
    engineRoot: parsed['engine-root'] && path.resolve(parsed['engine-root']), declarationsRoot: parsed['declarations-root'] && path.resolve(parsed['declarations-root']),
    editorRoot: parsed['editor-root'] && path.resolve(parsed['editor-root']), bridgeRoot: parsed['bridge-root'] && path.resolve(parsed['bridge-root']),
    pilotOutput: parsed['pilot-output'] && path.resolve(parsed['pilot-output']), shardSize: boundedInteger(parsed['shard-size'], 200, 1, 2000, 'shard-size'),
    shardBytes: boundedInteger(parsed['shard-bytes'], 2097152, 32768, 16777216, 'shard-bytes') };
}
function extractCatalog(options) {
  const records = [];
  const unknowns = [];
  const diagnostics = [];
  const inputs = [];
  let routes;
  if (options.kind !== 'bridge') {
    const manifestFile = path.join(options.engineRoot, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.version !== options.version) throw new Error(`Engine manifest ${manifest.version} does not match requested ${options.version}.`);
    const input = engineInputs(options.engineRoot);
    const engine = extractEngine(input, options.version);
    records.push(...engine.records); unknowns.push(...engine.unknowns);
    diagnostics.push(...[...input.diagnostics, ...input.program.getSyntacticDiagnostics()].map(item => diagnosticRow(item, options.engineRoot, 'engine')));
    inputs.push({ kind: 'engine', root: options.engineRoot, packageVersion: manifest.version, manifestSha256: hash(fs.readFileSync(manifestFile)) });
    if (options.declarationsRoot) {
      const declared = extractDeclarations(options.declarationsRoot, options.version);
      attachDeclarations(records, declared.records);
      unknowns.push(...declared.unknowns); diagnostics.push(...declared.diagnostics);
      inputs.push({ kind: 'declarations', root: options.declarationsRoot, assertedVersion: options.version, qualification: 'explicit-input-not-stock-proof' });
    }
  }
  let nativeRecords = [];
  if (options.editorRoot) {
    const editor = extractEditor(options.editorRoot, options.version);
    nativeRecords = editor.records;
    records.push(...nativeRecords); diagnostics.push(...editor.diagnostics);
    inputs.push({ kind: 'editor', root: options.editorRoot, packageVersion: options.version, manifestSha256: hash(fs.readFileSync(path.join(options.editorRoot, 'package.json'))) });
  }
  if (options.kind !== 'engine' && options.bridgeRoot) {
    const bridge = extractBridge(options.bridgeRoot, options.version, nativeRecords);
    records.push(...bridge.records); unknowns.push(...bridge.unresolved); routes = bridge.routes;
    inputs.push({ kind: 'bridge', root: options.bridgeRoot, qualification: 'static-composition-not-runtime-coverage' });
  }
  const index = writeCatalog(options.output, options.version, records, { unknowns, diagnostics, routes, provenance: { inputs } }, options);
  const pilot = options.pilotOutput ? writePilot(options.pilotOutput, options.version, records, index.catalogHash, options) : null;
  return { index, pilot, recordCount: records.length, routeCount: routes?.length || 0, diagnosticCount: diagnostics.length };
}
function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(HELP); return; }
  const result = extractCatalog(options);
  console.log(JSON.stringify({ output: options.output, version: options.version, catalogHash: result.index.catalogHash,
    records: result.recordCount, domains: result.index.domains.length, unresolved: result.index.unresolvedCount,
    composedRoutes: result.routeCount, diagnostics: result.diagnosticCount, pilotHash: result.pilot?.catalogHash || null }));
  return result;
}
if (require.main === module) { try { main(); } catch (error) { console.error(`catalog: ${error.message}`); process.exitCode = 1; } }
module.exports = { extractCatalog, parseOptions, main, HELP };
