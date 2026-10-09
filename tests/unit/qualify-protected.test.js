'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('qualification orchestrator stops before credentials are available', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'qualify-protected.js')], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, CCP_MEMBER_CREDENTIAL: '', CCP_MEMBER_CREDENTIAL_FILE: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CCP_MEMBER_CREDENTIAL/);
});

test('qualification status reports missing gates without exposing secret values', () => {
  const secret = 'member-secret-must-not-appear';
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'qualify-protected.js'), '--status'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      CCP_MEMBER_CREDENTIAL: secret,
      CCP_EXECUTION_PUBLIC_KEY: 'public-key',
      CCP_EXECUTION_KEY_ID: 'execution-1',
      CCP_PROJECT_ID: '',
      CCP_ADMIN_CREDENTIAL: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  const report = JSON.parse(result.stdout);
  assert.equal(report.readyForAutomation, false);
  assert.equal(report.nextBlockedGate, 'release-origin');
  assert.equal(report.checks.find((check) => check.gate === 'member-authentication').configured, true);
  assert.equal(report.checks.find((check) => check.gate === 'project-binding').configured, false);
});

test('qualification status accepts file-backed member and admin credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-qualification-'));
  const memberFile = path.join(directory, 'member.jwt');
  const adminFile = path.join(directory, 'admin.jwt');
  fs.writeFileSync(memberFile, 'member.token\n', { mode: 0o600 });
  fs.writeFileSync(adminFile, 'admin.token\n', { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'qualify-protected.js'), '--status'], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: {
        ...process.env,
        CCP_MEMBER_CREDENTIAL: '',
        CCP_MEMBER_CREDENTIAL_FILE: memberFile,
        CCP_ADMIN_CREDENTIAL: '',
        CCP_ADMIN_CREDENTIAL_FILE: adminFile,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.find((check) => check.gate === 'member-authentication').configured, true);
    assert.equal(report.checks.find((check) => check.gate === 'admin-authentication').configured, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('qualification status does not treat missing credential files as configured', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'qualify-protected.js'), '--status'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      CCP_MEMBER_CREDENTIAL: '',
      CCP_MEMBER_CREDENTIAL_FILE: path.join(path.dirname(__filename), 'missing-member.jwt'),
      CCP_ADMIN_CREDENTIAL: '',
      CCP_ADMIN_CREDENTIAL_FILE: path.join(path.dirname(__filename), 'missing-admin.jwt'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find((check) => check.gate === 'member-authentication').configured, false);
  assert.equal(report.checks.find((check) => check.gate === 'admin-authentication').configured, false);
});

test('qualification status rejects malformed inline credentials', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'qualify-protected.js'), '--status'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      CCP_MEMBER_CREDENTIAL: 'not a token',
      CCP_MEMBER_CREDENTIAL_FILE: '',
      CCP_ADMIN_CREDENTIAL: 'admin\ncredential',
      CCP_ADMIN_CREDENTIAL_FILE: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find((check) => check.gate === 'member-authentication').configured, false);
  assert.equal(report.checks.find((check) => check.gate === 'admin-authentication').configured, false);
});
