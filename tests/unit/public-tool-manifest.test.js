'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..', '..');
const relay = JSON.parse(readFileSync(join(root, 'source', 'protected', 'public-tool-manifest.json'), 'utf8'));
const gateway = JSON.parse(readFileSync(join(root, 'gateway', 'src', 'ccp', 'public-tool-manifest.json'), 'utf8'));
const relayFixture = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'protected', 'v1', 'public-tool-manifest.json'), 'utf8'));
const gatewayFixture = JSON.parse(readFileSync(join(root, 'gateway', 'tests', 'fixtures', 'ccp', 'v1', 'public-tool-manifest.json'), 'utf8'));

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function hash(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function behaviorOf(contract) {
  const copy = structuredClone(contract);
  delete copy.contractHash;
  return copy;
}

test('relay consumes the exact 43-tool Gateway artifact with content hashes', () => {
  assert.deepEqual(relay, gateway);
  assert.deepEqual(relayFixture, gateway);
  assert.deepEqual(gatewayFixture, gateway);
  assert.equal(relay.tools.length, 43);
  assert.equal(new Set(relay.tools.map((tool) => tool.name)).size, 43);
  assert.deepEqual(relay.tools.map((tool) => tool.name), relay.tools.map((tool) => tool.name).sort());
  assert.equal(hash({ schemaVersion: relay.schemaVersion, tools: relay.tools }), relay.manifestHash);
  for (const contract of relay.tools) {
    const behavior = behaviorOf(contract);
    assert.equal(hash(behavior), contract.contractHash);
    assert.equal(contract.primitiveAbiVersion, 2);
    behavior.limits.timeoutMs -= 1;
    assert.notEqual(hash(behavior), contract.contractHash);
  }
  assert.equal(relay.tools.find((tool) => tool.name === "assetBatchQuery").operations["*"].resultMode, "command-results");
});

test('finite animation and bounded project metadata are part of the artifact', () => {
  const animation = relay.tools.find((tool) => tool.name === 'animationEdit');
  assert.equal(animation.contractVersion, 2);
  assert.equal(Object.hasOwn(animation.operations, 'operate'), false);
  assert.equal(animation.allowedInputFields.includes('operations'), false);
  const project = relay.tools.find((tool) => tool.name === 'projectManage');
  const key = project.inputFields.find((field) => field.jsonPointer === '/key');
  const path = project.inputFields.find((field) => field.jsonPointer === '/path');
  assert.deepEqual({ dataClass: key.dataClass, maxBytes: key.maxBytes, gatewayTransfer: key.gatewayTransfer }, { dataClass: 'project-metadata', maxBytes: 4096, gatewayTransfer: 'allowed' });
  assert.deepEqual({ dataClass: path.dataClass, maxBytes: path.maxBytes, gatewayTransfer: path.gatewayTransfer }, { dataClass: 'project-metadata', maxBytes: 4096, gatewayTransfer: 'allowed' });
});
