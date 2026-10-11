'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const sourceRoot = path.join(root, 'source/engine-api-catalog');
const destinationRoot = path.join(root, 'dist/engine-api-catalog');
const MAX_TOTAL = 8 * 1024 * 1024;
let total = 0;
for (const version of ['3.7.3', '3.8.8']) {
  const source = path.join(sourceRoot, version);
  const index = JSON.parse(fs.readFileSync(path.join(source, 'index.json'), 'utf8'));
  if (index.version !== version || index.schemaVersion !== 1 || !Array.isArray(index.domains)) throw new Error('Invalid pilot catalog index');
  const files = ['index.json', ...index.domains.map(domain => domain.file)];
  for (const file of files) {
    if (path.basename(file) !== file || !file.endsWith('.json')) throw new Error('Unsafe catalog runtime path');
    total += fs.statSync(path.join(source, file)).size;
    if (total > MAX_TOTAL) throw new Error('Pilot runtime metadata exceeds 8MiB; do not ship the full engine catalog');
  }
  const destination = path.join(destinationRoot, version);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(source, file), path.join(destination, file));
}
console.log(JSON.stringify({ runtimeCatalogBytes: total, versions: ['3.7.3', '3.8.8'], engineSourceIncluded: false, compilerIncluded: false }));
