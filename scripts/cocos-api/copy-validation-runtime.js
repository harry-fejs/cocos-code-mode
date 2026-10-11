'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'node_modules/zod');
const destination = path.join(root, 'dist/vendor/zod');
fs.rmSync(destination, { recursive: true, force: true });
let files = 0;
function copy(directory, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) { copy(path.join(directory, entry.name), path.join(target, entry.name)); continue; }
    if (!entry.name.endsWith('.cjs')) continue;
    const content = fs.readFileSync(path.join(directory, entry.name), 'utf8').replace(/(require\(["'][^"']+)\.cjs(["']\))/g, '$1.js$2');
    fs.writeFileSync(path.join(target, entry.name.replace(/\.cjs$/, '.js')), content);
    files++;
  }
}
copy(source, destination);
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
console.log(JSON.stringify({ validationRuntimeFiles: files, source: 'installed-zod-commonjs', esmIncluded: false }));
