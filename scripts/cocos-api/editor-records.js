'use strict';
const { ts, fs, path, files, source, compare, finalize, slash, json } = require('./catalog-utils');
const { createProgram, diagnosticRow } = require('./compiler-inputs');
const { signatures, typeInfo, compact, metadata } = require('./type-metadata');
const normalize = name => name.replace(/[-_]/g, '').toLowerCase();
function extractEditor(root, version) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`Editor ${manifest.version} does not match requested ${version}.`);
  const builtin = path.join(root, 'builtin');
  const packages = fs.readdirSync(builtin, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(builtin, entry.name)).sort(compare);
  const declarations = packages.flatMap(directory => fs.existsSync(path.join(directory, '@types')) ? files(path.join(directory, '@types'), file => /\.d\.ts$/.test(file)) : []);
  const inputRoots = [...declarations];
  const engineDeclarations = path.join(root, '..', 'resources', '3d', 'engine', 'bin', '.declarations');
  if (fs.existsSync(engineDeclarations)) inputRoots.push(...files(engineDeclarations, file => /\.d\.ts$/.test(file)));
  const { program, checker, diagnostics } = createProgram(root, inputRoots, { types: [], allowJs: false, module: ts.ModuleKind.CommonJS });
  const typed = new Map();
  const facades = new Map();
  for (const sf of program.getSourceFiles()) {
    if (!declarations.includes(sf.fileName)) continue;
    const module = slash(path.relative(builtin, sf.fileName)).split('/')[0];
    function visit(node) {
      if (path.basename(sf.fileName) === 'message.d.ts' && ts.isInterfaceDeclaration(node) && node.name.text === 'message') {
        for (const member of node.members) if (member.name && member.type && ts.isTypeLiteralNode(member.type)) {
          const params = member.type.members.find(item => item.name?.getText() === 'params');
          const result = member.type.members.find(item => item.name?.getText() === 'result');
          const parameterInfo = params?.type ? typeInfo(checker, checker.getTypeFromTypeNode(params.type), params.type) : { type: 'unknown', unresolved: [{ kind: 'params', reference: 'Missing params declaration' }] };
          const resultInfo = result?.type ? typeInfo(checker, checker.getTypeFromTypeNode(result.type), result.type) : { type: 'unknown', unresolved: [{ kind: 'result', reference: 'Missing result declaration' }] };
          const name = member.name.text || member.name.getText();
          typed.set(`${module}:${name}`, { signatures: [{ overload: 0, kind: 'ipc', params: parameterInfo.type, declaredParams: compact(params?.type),
            returnType: resultInfo.type, declaredReturnType: compact(result?.type), parameterReferences: parameterInfo.references || [], returnReferences: resultInfo.references || [],
            unresolved: [...parameterInfo.unresolved, ...resultInfo.unresolved] }], source: source(member, root, 'editor') });
        }
      }
      if (/facade/i.test(sf.fileName) && (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) {
          const key = `${module}:${normalize(node.name.getText())}`;
          const rows = facades.get(key) || [];
          const row = { className: node.parent.name?.getText() || null, member: node.name.getText(), signatures: signatures(checker, symbol, node),
            ...metadata(node), source: source(node, root, 'editor'), association: 'normalized-name-signature-candidate-not-behavior-proof' };
          if (!rows.some(item => item.source.path === row.source.path && item.member === row.member)) rows.push(row);
          facades.set(key, rows);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  const records = [];
  for (const directory of packages) {
    const file = path.join(directory, 'package.json');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const pkg = JSON.parse(raw);
    const module = path.basename(directory);
    const registrySource = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSON);
    for (const [name, definition] of Object.entries(pkg.contributions?.messages || {}).sort(([a], [b]) => compare(a, b))) {
      const declared = typed.get(`${module}:${name}`);
      const facadeMatches = facades.get(`${module}:${normalize(name)}`) || [];
      const resolvedSignatures = declared?.signatures || [];
      const unresolved = resolvedSignatures.length ? resolvedSignatures.flatMap(signature => signature.unresolved) : [{ kind: 'signature', reference: name, reason: 'Registry has no matching message declaration' }];
      const node = registrySource;
      records.push(finalize({ version, namespace: 'editor-ipc', module, className: null, member: name, name, kind: 'message', domain: module,
        signatures: resolvedSignatures, decorators: [], visibility: definition.public === true ? 'public' : 'internal', static: false, readonly: false,
        internal: definition.public !== true, deprecated: !!definition.deprecated, inheritance: [], inheritedFrom: null,
        registry: { public: definition.public === true, methods: definition.methods || [], doc: definition.doc || null, permissions: definition.permissions || null },
        facadeMatches, source: source(node, root, 'editor'), declarationEvidence: declared ? { source: declared.source } : null,
        evidenceStatus: unresolved.length ? 'declared' : 'signatureResolved', contextConstraints: { execution: ['editor-main', 'edit-scene'], targetAvailable: 'unknown',
          feature: 'matching-editor-builtin', nativeFacadeAssociation: facadeMatches.length ? 'candidate' : 'unresolved', jsonTransfer: 'declared-ipc-dto-required' },
        unresolved, discovered: true, permitted: false, publicExport: definition.public === true,
        evidence: [{ kind: 'native-registry', path: slash(path.relative(root, file)), jsonPointer: `/contributions/messages/${name.replace(/~/g, '~0').replace(/\//g, '~1')}` }] }));
    }
  }
  return { records, diagnostics: [...diagnostics, ...program.getSyntacticDiagnostics()].map(item => diagnosticRow(item, root, 'editor')) };
}
module.exports = { extractEditor };
