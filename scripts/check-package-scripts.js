#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const required = {
  'link:project': 'node ./scripts/link-project-extension.js',
  'link:plans': 'python ../../../_devtools/cfg-n-scripts/notes/08_System/mount_project_plans.py --here',
};
let ok = true;
for (const [k, v] of Object.entries(required)) {
  if (pkg.scripts?.[k] !== v) {
    console.error(`[check:package-scripts] missing or drifted scripts["${k}"] — expected "${v}", got "${pkg.scripts?.[k]}"`);
    ok = false;
  }
}
if (!pkg.scripts?.['gen:catalog']) {
  console.error('[check:package-scripts] missing scripts["gen:catalog"]');
  ok = false;
}
const expectedBuild = [
  'node ./scripts/check-package-scripts.js',
  'node ./scripts/generate-build-info.js',
  'npx tsc',
  'node ./scripts/copy-cocos-graph-runtime.js',
  'node ./scripts/cocos-api/copy-runtime-catalog.js',
  'node ./scripts/cocos-api/copy-validation-runtime.js',
  'node scripts/check-creator-load.js',
].join(' && ');
if (pkg.scripts?.build !== expectedBuild) {
  console.error(`[check:package-scripts] scripts.build must exactly match: ${expectedBuild}`);
  ok = false;
}
if (pkg.scripts?.['build:debug'] !== 'npm run build && node scripts/minify-debug.js && node scripts/check-creator-load.js') {
  console.error('[check:package-scripts] build:debug must preserve readable build and both load gates');
  ok = false;
}
if (!ok) process.exit(1);
console.log('[check:package-scripts] OK — required scripts present');
