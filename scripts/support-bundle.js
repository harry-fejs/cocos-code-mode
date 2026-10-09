'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const root = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), `ccp-support-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const copied = [];

function readJson(file) {
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`support input is not a bounded file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function emit(name, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, name), text, { flag: 'wx', mode: 0o600 });
  copied.push({ file: name, sha256: createHash('sha256').update(text).digest('hex') });
}

const packageJson = readJson(path.join(root, 'package.json'));
const buildInfo = readJson(path.join(root, 'dist', 'build-info.json'));
emit('build.json', {
  schemaVersion: 1,
  package: packageJson?.name,
  packageVersion: packageJson?.version,
  creatorRange: packageJson?.editor,
  build: buildInfo && {
    version: buildInfo.version,
    commit: buildInfo.commit,
    branch: buildInfo.branch,
    dirty: buildInfo.dirty,
    builtAt: buildInfo.builtAt,
  },
});

const targetWrapper = readJson(path.join(root, 'dist', 'release-target.signed.json'));
if (targetWrapper && typeof targetWrapper.payload === 'string') {
  const target = JSON.parse(Buffer.from(targetWrapper.payload, 'base64url').toString('utf8'));
  emit('release.json', {
    schemaVersion: 1,
    metadataVersion: target.metadataVersion,
    sequence: target.sequence,
    expiresAt: target.expiresAt,
    package: target.package && {
      version: target.package.version,
      buildId: target.package.buildId,
      sha256: target.package.sha256,
      size: target.package.size,
      packageManifestSha256: target.package.packageManifestSha256,
      sbomSha256: target.package.sbomSha256,
      provenanceSha256: target.package.provenanceSha256,
    },
    protocol: target.protocol,
    platform: target.platform,
  });
}

const state = readJson(path.join(os.homedir(), '.ccp', 'update-state-v1.json'));
if (state) {
  emit('update-state.json', {
    schemaVersion: state.schemaVersion,
    highestRootVersion: state.highestRootVersion,
    highestTargetSequence: state.highestTargetSequence,
    highestPolicySequence: state.highestPolicySequence,
    rootPayloadSha256: state.rootPayloadSha256,
    targetPayloadSha256: state.targetPayloadSha256,
    policyPayloadSha256: state.policyPayloadSha256,
    activeTargetPayloadSha256: state.activeTargetPayloadSha256,
    stagedTargetPayloadSha256: state.stagedTargetPayloadSha256,
    stagedDescriptorSha256: state.stagedDescriptorSha256,
    rollbackTargetPayloadSha256: state.rollbackTargetPayloadSha256,
    channel: state.channel,
    ring: state.ring,
    activationState: state.activationState,
  });
}

const forbiddenMarkers = [
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /MC4CAQAwBQYDK2VwBCIE/,
  /\b(?:bearer|password|credential|private[_-]?key|pkcs8|secret|signature)\b/i,
  /https?:\/\//i,
  /\.utcp-debug/i,
];
for (const entry of copied) {
  const body = fs.readFileSync(path.join(outDir, entry.file), 'utf8');
  for (const marker of forbiddenMarkers) {
    if (marker.test(body)) {
      fs.rmSync(outDir, { recursive: true, force: true });
      throw new Error(`support bundle refused: forbidden marker in ${entry.file}`);
    }
  }
}

const index = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  excludes: ['project payloads', 'credentials', 'signatures', 'URLs', 'screenshots', 'observation bodies', 'source', 'results'],
  files: copied,
};
emit('bundle.json', index);
console.log(outDir);
console.log('support bundle: metadata allowlist and canary scan clean');
