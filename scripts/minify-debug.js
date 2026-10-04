'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { minify } = require('terser');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const maps = path.join(root, '.debug-maps');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : /\.(js|mjs)$/.test(entry.name) ? [file] : [];
  });
}
async function main() {
  const results = [];
  const graph = {};
  let beforeBytes = 0;
  let afterBytes = 0;
  for (const file of files(dist)) {
    const relative = path.relative(dist, file).replace(/\\/g, '/');
    const input = fs.readFileSync(file, 'utf8');
    const inline = input.match(/\/\/# sourceMappingURL=data:application\/json[^,]*;base64,([^\s]+)/);
    const content = inline ? JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8')) : undefined;
    const result = await minify({ [relative]: input }, {
      ecma: 2017, module: file.endsWith('.mjs'),
      compress: { defaults: false, dead_code: true, conditionals: true, evaluate: true, booleans: true },
      mangle: { toplevel: false, properties: false },
      keep_classnames: true, keep_fnames: true,
      format: { comments: false },
      sourceMap: { content, filename: relative, includeSources: true },
    });
    if (typeof result.code !== 'string' || typeof result.map !== 'string') throw new Error(`Incomplete transform: ${relative}`);
    if (/sourceMappingURL|sourceURL/.test(result.code)) throw new Error(`Embedded source reference: ${relative}`);
    results.push({ file, relative, code: result.code + '\n', map: result.map });
    beforeBytes += Buffer.byteLength(input);
    afterBytes += Buffer.byteLength(result.code + '\n');
    if (relative.startsWith('cocos-graph/')) graph[relative] = { source: hash(input), output: hash(result.code + '\n') };
  }
  // Transform everything successfully before replacing output; never report partial transform success.
  fs.rmSync(maps, { recursive: true, force: true });
  for (const result of results) {
    const mapFile = path.join(maps, result.relative + '.map');
    fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    fs.writeFileSync(mapFile, result.map);
    fs.writeFileSync(result.file, result.code);
  }
  const infoFile = path.join(dist, 'build-info.json');
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  info.mode = 'debug-minified';
  info.transform = { tool: 'terser', version: require('terser/package.json').version, mangle: 'local-identifiers', properties: false, graph };
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2) + '\n');
  console.log(JSON.stringify({ mode: info.mode, files: results.length, beforeBytes, afterBytes, privateMaps: '.debug-maps' }));
}
main().catch(error => { console.error('[minify:debug] FAILED', error); process.exitCode = 1; });
