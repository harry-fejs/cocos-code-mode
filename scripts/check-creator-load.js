'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const crypto = require('node:crypto');

function checkCreatorLoad(root = path.resolve(__dirname, '..')) {
  const previousJs = Module._extensions['.js'];
  const previousCjs = Module._extensions['.cjs'];
  const previousEditor = global.Editor;
  const loaded = new Set();
  function creatorCompile(module, filename) {
    const base = path.basename(filename, path.extname(filename));
    const sibling = path.join(path.dirname(filename), `${base}.js`);
    const selected = fs.existsSync(sibling) ? sibling : filename;
    const source = fs.readFileSync(selected, 'utf8').replace(/^\uFEFF/, '');
    // Modern Node can auto-detect ESM in _compile; Creator 3.7 cannot.
    new vm.Script(Module.wrap(source), { filename: selected });
    loaded.add(selected);
    module._compile(source, selected);
  }
  function checkGraphRuntime() {
    const graphDirectory = path.join(root, 'dist', 'cocos-graph');
    const sourceDirectory = path.join(root, 'tools', 'cocos-graph', 'src');
    const copiedSourceDirectory = path.join(graphDirectory, 'src');
    const graphSourceExists = fs.existsSync(sourceDirectory);
    const graphCopyExists = fs.existsSync(copiedSourceDirectory);
    if (!graphSourceExists && !graphCopyExists) return 0;
    if (!graphSourceExists || !graphCopyExists) throw new Error('Cocos Graph runtime source and copied package must be present together.');
    const ts = require('typescript');
    const sourceModules = fs.readdirSync(sourceDirectory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
      .map(entry => entry.name)
      .sort();
    const copiedModules = fs.readdirSync(copiedSourceDirectory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
      .map(entry => entry.name)
      .sort();
    if (JSON.stringify(sourceModules) !== JSON.stringify(copiedModules)) {
      throw new Error('Copied cocos-graph core module set does not match tools/cocos-graph/src/*.mjs');
    }
    const files = [
      ...sourceModules.map(name => path.join(copiedSourceDirectory, name)),
      path.join(graphDirectory, 'runtime-worker.mjs'),
    ];
    for (const file of files) {
      if (!fs.statSync(file).isFile()) throw new Error(`Missing copied cocos-graph module: ${file}`);
      const checked = require('node:child_process').spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (checked.error) throw checked.error;
      if (checked.status !== 0) throw new Error(`Creator-compatible ESM parse failed for ${file}: ${checked.stderr || checked.stdout}`);
      const sourceFile = file.startsWith(copiedSourceDirectory)
        ? path.join(sourceDirectory, path.basename(file))
        : path.join(root, 'tools', 'cocos-graph', path.basename(file));
      const buildInfo = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-info.json'), 'utf8'));
      const relative = path.relative(path.join(root, 'dist'), file).replace(/\\/g, '/');
      const transformed = buildInfo.mode === 'debug-minified' ? buildInfo.transform?.graph?.[relative] : null;
      if (transformed) {
        const digest = input => crypto.createHash('sha256').update(input).digest('hex');
        if (digest(fs.readFileSync(sourceFile)) !== transformed.source || digest(fs.readFileSync(file)) !== transformed.output) throw new Error(`Transformed graph provenance mismatch: ${file}`);
      } else
      if (!fs.existsSync(sourceFile) || fs.readFileSync(sourceFile, 'utf8') !== fs.readFileSync(file, 'utf8')) {
        throw new Error(`Copied cocos-graph module differs from source: ${file}`);
      }
      const module = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      for (const statement of module.statements) {
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), specifier.text);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          throw new Error(`Unresolved cocos-graph ESM import ${specifier.text} from ${file}`);
        }
      }
    }
    return files.length;
  }
  function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(file) : entry.name.endsWith('.js') ? [file] : [];
    });
  }
  try {
    const graphModules = checkGraphRuntime();
    Module._extensions['.js'] = creatorCompile;
    Module._extensions['.cjs'] = creatorCompile;
    // Import only: never invoke load/ready or mutate Creator/project state.
    global.Editor = { Panel: { define: definition => definition } };
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const entries = [manifest.main, manifest.contributions?.scene?.script,
      ...Object.values(manifest.panels || {}).map(panel => panel.main)].filter(Boolean);
    for (const entry of entries) require(path.resolve(root, entry));
    const modules = walk(path.join(root, 'dist'));
    for (const file of modules) require(file);
    // Load deferred literal Node/package requires too; engine virtual modules
    // (cc/db://) need Creator itself and are explicitly outside this gate.
    const ts = require('typescript');
    const deferred = new Set();
    const unverified = new Set();
    for (const file of modules) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'require') {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            const specifier = arg.text;
            if (specifier === 'cc' || specifier === 'electron' || specifier.startsWith('db://')) unverified.add(specifier);
            else {
              const localRequire = Module.createRequire(file);
              localRequire(specifier);
              deferred.add(specifier);
            }
          } else unverified.add(`${path.relative(root, file)}: dynamic require`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    return { entries: entries.length, modules: modules.length, graphModules, loadedFiles: loaded.size, literalRequires: deferred.size, unverified: [...unverified] };
  } finally {
    Module._extensions['.js'] = previousJs;
    if (previousCjs) Module._extensions['.cjs'] = previousCjs;
    else delete Module._extensions['.cjs'];
    global.Editor = previousEditor;
  }
}

module.exports = { checkCreatorLoad };
if (require.main === module) {
  try { console.log('CREATOR_LOAD_OK ' + JSON.stringify(checkCreatorLoad(process.argv[2] ? path.resolve(process.argv[2]) : undefined))); }
  catch (error) { console.error('CREATOR_LOAD_FAILED', error.stack || error); process.exitCode = 1; }
}
