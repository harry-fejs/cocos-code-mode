'use strict';
const { ts, fs, path, files, slash, source } = require('./catalog-utils');
function createProgram(root, roots, overrides = {}) {
  const configPath = path.join(root, 'tsconfig.json');
  let options = {};
  const diagnostics = [];
  if (fs.existsSync(configPath)) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) diagnostics.push(loaded.error);
    if (loaded.config) {
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
      options = parsed.options;
      diagnostics.push(...parsed.errors);
    }
  }
  options = { ...options, noEmit: true, incremental: false, composite: false, skipLibCheck: true,
    experimentalDecorators: true, target: ts.ScriptTarget.ES2020, ...overrides };
  const program = ts.createProgram({ rootNames: roots, options });
  const checker = program.getTypeChecker();
  diagnostics.push(...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics());
  for (const file of program.getSourceFiles()) if (!program.isSourceFileDefaultLibrary(file)) {
    diagnostics.push(...program.getSemanticDiagnostics(file).filter(item => [2304, 2307, 2503, 2688, 2694, 2792].includes(item.code)));
  }
  return { program, checker, diagnostics };
}
function engineInputs(root) {
  const runtime = files(path.join(root, 'exports'), file => /\.tsx?$/.test(file));
  if (!runtime.length) throw new Error('Engine has no TypeScript export roots.');
  const authoringPath = path.join(root, 'editor', 'exports');
  const authoring = fs.existsSync(authoringPath) ? files(authoringPath, file => /\.tsx?$/.test(file)) : [];
  const globalsPath = path.join(root, '@types');
  const globals = fs.existsSync(globalsPath) ? files(globalsPath, file => /\.d\.ts$/.test(file)) : [];
  const config = fs.existsSync(path.join(root, 'cc.config.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'cc.config.json'), 'utf8')) : {};
  const compiler = createProgram(root, [...runtime, ...authoring, ...globals]);
  return { ...compiler, root, runtime, authoring, config };
}
function moduleRoots(input) {
  const result = [];
  for (const file of input.runtime) result.push({ file, namespace: 'engine-runtime', module: 'cc', domain: path.basename(file, '.ts'),
    features: Object.entries(input.config.features || {}).filter(([, feature]) => (feature.modules || []).includes(path.basename(file, '.ts'))).map(([name]) => name) });
  for (const file of input.authoring) result.push({ file, namespace: 'engine-authoring', module: `cc/editor/${path.basename(file, '.ts')}`, domain: path.basename(file, '.ts'), features: [] });
  return result;
}
function declarationRoots(root) {
  return files(root, file => /\.d\.ts$/.test(file));
}
function ambientModules(program, checker) {
  return checker.getAmbientModules().filter(symbol => /^"cc(?:\/editor\/[^\"]+)?"$/.test(symbol.name));
}
function resolveAlias(checker, symbol) {
  const seen = new Set();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
    if (seen.has(symbol)) return null;
    seen.add(symbol);
    const next = checker.getAliasedSymbol(symbol);
    if (!next || next === symbol || next.name === 'unknown') return null;
    symbol = next;
  }
  return symbol;
}
function diagnosticRow(diagnostic, root, label) {
  const sf = diagnostic.file;
  return { root: label, path: sf ? slash(path.relative(root, sf.fileName)) : null,
    line: sf && diagnostic.start !== undefined ? sf.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : null,
    code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') };
}
module.exports = { createProgram, engineInputs, moduleRoots, declarationRoots, ambientModules, resolveAlias, diagnosticRow, source };
