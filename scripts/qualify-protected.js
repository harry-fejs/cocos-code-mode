'use strict';
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const { readCredential } = require('./credential-input');
const credentialDir = path.join(os.homedir(), '.cc-bridge', 'credentials');
const defaultCredentialFiles = {
  CCB_MEMBER_CREDENTIAL_FILE: path.join(credentialDir, 'member.jwt'),
  CCB_ADMIN_CREDENTIAL_FILE: path.join(credentialDir, 'admin.jwt'),
};
for (const [name, file] of Object.entries(defaultCredentialFiles)) {
  if (!process.env[name] && fs.existsSync(file)) process.env[name] = file;
}
const required = [
  { variables: ['CCB_MEMBER_CREDENTIAL', 'CCB_MEMBER_CREDENTIAL_FILE'], label: 'member EdDSA JWT', any: true, credential: true },
];

function fail(message) { throw new Error(message); }
function run(command, args) {
  console.log(`\n==> ${command} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', command)], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) fail(`${command} failed with exit ${result.status}`);
}

function configuredCredential(valueName, fileName) {
  try {
    return readCredential(valueName, fileName, process.env) !== undefined;
  } catch {
    return false;
  }
}

function configured(check) {
  if (check.credential) {
    const [valueName, fileName] = check.variables;
    return configuredCredential(valueName, fileName);
  }
  return check.any
    ? check.variables.some((name) => Boolean(process.env[name]))
    : check.variables.every((name) => Boolean(process.env[name]));
}
function checkConfiguration() {
  const missing = required
    .filter((input) => !configured(input))
    .map((input) => `${input.variables.join(' or ')} (${input.label})`);
  if (missing.length) fail(`missing required protected qualification inputs:\n- ${missing.join('\n- ')}`);
  if (!process.env.CCB_PROJECT_ID) console.warn('CCB_PROJECT_ID not set; enrollment can proceed, protected execution cannot.');
  if (!process.env.CCB_ADMIN_CREDENTIAL && !process.env.CCB_ADMIN_CREDENTIAL_FILE) console.warn('Admin credential not set; admin operations will be skipped.');
  if (process.env.CCB_RELEASE_ORIGIN && !/^https:\/\//.test(process.env.CCB_RELEASE_ORIGIN)) fail('CCB_RELEASE_ORIGIN must use HTTPS when configured');
}

function statusReport() {
  const checks = [
    { gate: "release-origin", variables: ["CCB_RELEASE_ORIGIN"] },
    { gate: "signed-release-inputs", variables: ["CCB_RELEASE_ROOT_METADATA_PATH", "CCB_RELEASE_ZIP", "CCB_RELEASE_ROOT_PATH", "CCB_RELEASE_ROOT_SHA256"] },
    { gate: "member-authentication", variables: ["CCB_MEMBER_CREDENTIAL", "CCB_MEMBER_CREDENTIAL_FILE"], credential: true },
    { gate: "project-binding", variables: ["CCB_PROJECT_ID"] },
    { gate: "device-identity", variables: ["CCB_DEVICE_IDENTITY_PATH"], optional: true },
    { gate: "execution-verification", variables: ["CCB_EXECUTION_KEY_ID", "CCB_EXECUTION_PUBLIC_KEY"] },
    { gate: "admin-authentication", variables: ["CCB_ADMIN_CREDENTIAL", "CCB_ADMIN_CREDENTIAL_FILE"], credential: true },
    { gate: "scoped-grant", variables: ["CCB_GRANT_DEVICE_ID", "CCB_GRANT_PROJECT_ID", "CCB_GRANT_OPERATION_CLASS"] },
  ].map((check) => {
    return { gate: check.gate, configured: configured(check), optional: Boolean(check.optional), variables: check.variables };
  });
  const requiredChecks = checks.filter((check) => !check.optional);
  const next = requiredChecks.find((check) => !check.configured);
  console.log(JSON.stringify({
    readyForAutomation: !next,
    nextBlockedGate: next ? next.gate : null,
    checks,
  }, null, 2));
}

function main() {
  if (process.argv.includes("--status")) {
    statusReport();
    return;
  }
  checkConfiguration();
  const connection = require('./project-connection').selectConnection();
  if (!connection.gateway.origin || !connection.gateway.projectId) fail('selected Cocos project has no configured Gateway assignment');
  if (process.env.CCB_GATEWAY_ORIGIN && new URL(process.env.CCB_GATEWAY_ORIGIN).origin !== connection.gateway.origin) fail('CCB_GATEWAY_ORIGIN differs from selected project assignment');
  if (process.env.CCB_PROJECT_ID && process.env.CCB_PROJECT_ID !== connection.gateway.projectId) fail('CCB_PROJECT_ID differs from selected project Gateway project');
  process.env.CCB_GATEWAY_ORIGIN = connection.gateway.origin;
  process.env.CCB_PROJECT_ID = connection.gateway.projectId;
  process.env.CCB_PROJECT_PATH = connection.projectPath;
  run('check-live-prereqs.js', []);
  run('enroll-device.js', []);
  if (process.env.CCB_ADMIN_CREDENTIAL || process.env.CCB_ADMIN_CREDENTIAL_FILE) {
    run('manage-device.js', ['list-devices']);
    if (process.env.CCB_APPROVED_DEVICE_ID) run('manage-device.js', ['approve', process.env.CCB_APPROVED_DEVICE_ID]);
    if (process.env.CCB_GRANT_OPERATION_CLASS && process.env.CCB_GRANT_DEVICE_ID && process.env.CCB_GRANT_PROJECT_ID) {
      run('manage-device.js', ['grant']);
    } else {
      console.warn('Grant skipped; set CCB_GRANT_DEVICE_ID, CCB_GRANT_PROJECT_ID, and CCB_GRANT_OPERATION_CLASS after reviewing pending devices.');
    }
  }
  console.log('\nLocal qualification automation completed through enrollment. Signed updater activation and Creator protected workflow execution remain explicit live-runtime steps.');
}
try { main(); } catch (error) { console.error(`qualify-protected failed: ${error.message}`); process.exitCode = 1; }
