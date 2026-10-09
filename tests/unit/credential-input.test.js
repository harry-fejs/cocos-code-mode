'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readCredential } = require('../../scripts/credential-input');

test('credential input reads one bounded token from an absolute file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-credential-'));
  try {
    const file = path.join(directory, 'member.jwt');
    fs.writeFileSync(file, 'header.payload.signature\n', { mode: 0o600 });
    assert.equal(readCredential('VALUE', 'FILE', { FILE: file }), 'header.payload.signature');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('credential input rejects ambiguous, relative, and whitespace-bearing values', () => {
  assert.throws(() => readCredential('VALUE', 'FILE', { VALUE: 'token', FILE: 'token.jwt' }), /only one/);
  assert.throws(() => readCredential('VALUE', 'FILE', { FILE: 'token.jwt' }), /absolute path/);
  assert.throws(() => readCredential('VALUE', 'FILE', { VALUE: 'two tokens' }), /without whitespace/);
});
