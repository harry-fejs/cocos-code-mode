#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(root, 'gateway', 'src', 'ccp', 'public-tool-manifest.json');
const generatedPaths = [
  path.join(root, 'source', 'protected', 'public-tool-manifest.json'),
  path.join(root, 'gateway', 'tests', 'fixtures', 'ccp', 'v1', 'public-tool-manifest.json'),
  path.join(root, 'tests', 'fixtures', 'protected', 'v1', 'public-tool-manifest.json'),
];

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new TypeError('public contract contains a non-JSON value');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashBehavior(contract) {
  const { contractHash: _contractHash, ...behavior } = contract;
  return sha256(canonicalize(behavior));
}

const source = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
if (source.schemaVersion !== 2 || !Array.isArray(source.tools) || source.tools.length !== 43) {
  throw new Error('canonical public tool manifest must be schema v2 with exactly 43 tools');
}
const tools = source.tools.map((contract) => ({ ...contract, contractHash: hashBehavior(contract) }))
  .sort((left, right) => left.name.localeCompare(right.name));
if (new Set(tools.map((tool) => tool.name)).size !== 43) throw new Error('canonical public tool names must be unique');
const manifest = { schemaVersion: 2, manifestHash: sha256(canonicalize({ schemaVersion: 2, tools })), tools };
const output = `${JSON.stringify(manifest, null, 2)}\n`;
fs.writeFileSync(canonicalPath, output, 'utf8');
for (const destination of generatedPaths) fs.writeFileSync(destination, output, 'utf8');

const publicSources = [
  'canonical-json.ts', 'canonical-json.LICENSE.txt', 'protocol.ts', 'primitive-contract.ts',
  'errors.ts', 'schemas.ts', 'negative-fixture-runner.ts', 'public-tool-manifest.json',
];
const fixtureRoots = [
  path.join(root, 'gateway', 'tests', 'fixtures', 'ccp', 'v1'),
  path.join(root, 'tests', 'fixtures', 'protected', 'v1'),
];
for (const fixtureRoot of fixtureRoots) {
  const fixtureManifestPath = path.join(fixtureRoot, 'ccp-manifest.json');
  const fixtureManifest = JSON.parse(fs.readFileSync(fixtureManifestPath, 'utf8'));
  fixtureManifest.publicSources = Object.fromEntries(publicSources.map((file) => {
    const sourcePath = file === 'public-tool-manifest.json'
      ? path.join(fixtureRoot, file)
      : path.join(root, fixtureRoot.includes(`${path.sep}gateway${path.sep}`) ? 'gateway/src/ccp' : 'source/protected', file);
    return [file, sha256(fs.readFileSync(sourcePath))];
  }));
  fs.writeFileSync(fixtureManifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`, 'utf8');
}

process.stdout.write(`${JSON.stringify({ tools: tools.length, manifestHash: manifest.manifestHash })}\n`);
