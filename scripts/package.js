'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ZipArchive } = require('archiver');
const { assertReleaseInventory, collectPackageEntries, createPackageManifest, sha256 } = require('./release-inventory');
const { fixedAclOutput } = require('./fixed-acl-witness');
const { writeCanonicalJson, writeReleaseSidecars } = require('./release-artifacts');

const projectRoot = path.join(__dirname, '..');
const packageJson = require(path.join(projectRoot, 'package.json'));
const packageName = packageJson.name;
const ZIP_EPOCH_SECONDS = Number(process.env.SOURCE_DATE_EPOCH || 315532800);
if (!Number.isSafeInteger(ZIP_EPOCH_SECONDS) || ZIP_EPOCH_SECONDS < 315532800) {
  throw new Error('SOURCE_DATE_EPOCH must be an integer at or after 1980-01-01');
}
const archiveDate = new Date(ZIP_EPOCH_SECONDS * 1000);

function runWitness(script) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`${script} failed`);
}

function assertCleanTrackedSource() {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('cannot determine release source state');
  if (result.stdout.trim()) throw new Error('refuse production package from a dirty tracked worktree');
}

function buildInfo() {
  const filePath = path.join(projectRoot, 'dist', 'build-info.json');
  const info = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!info.commit || info.commit === 'unknown' || info.dirty) {
    throw new Error('release build requires a clean recorded source commit');
  }
  return info;
}

function zipVersion(info) {
  return `${packageJson.version}-dev.${info.commit}`;
}

function outputName(version) {
  return `${packageName}-v${version.replace(/[^A-Za-z0-9.-]/g, '-')}.zip`;
}

function makeBuildInfoDeterministic(entries) {
  const entry = entries.find((candidate) => candidate.relativePath === 'dist/build-info.json');
  if (!entry) throw new Error('dist/build-info.json missing from package inventory');
  const source = JSON.parse(fs.readFileSync(entry.sourcePath, 'utf8'));
  const bytes = Buffer.from(JSON.stringify({ ...source, builtAt: archiveDate.toISOString() }, null, 2));
  entry.sourcePath = null;
  entry.bytes = bytes;
  entry.size = bytes.length;
  entry.sha256 = sha256(bytes);
}

async function createZip(outputPath, entries) {
  const output = fs.createWriteStream(outputPath, { flags: 'wx' });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const closed = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });
  archive.pipe(output);
  for (const entry of entries) {
    const options = { name: entry.archivePath, date: archiveDate, mode: entry.mode };
    const bytes = entry.bytes || fs.readFileSync(entry.sourcePath);
    archive.append(bytes, options);
  }
  await archive.finalize();
  await closed;
}

async function main() {
  assertCleanTrackedSource();
  runWitness('scan-protected-absence.js');
  runWitness('forbidden-material-witness.js');

  const info = buildInfo();
  const version = zipVersion(info);
  const patchedPackageJson = { ...packageJson, version };
  const entries = collectPackageEntries(projectRoot, packageName, patchedPackageJson);
  makeBuildInfoDeterministic(entries);
  assertReleaseInventory(entries, {
    requireActivationLauncher: true,
    approvedAclOutput: fixedAclOutput(path.join(projectRoot, 'dist')),
  });

  const manifest = createPackageManifest(packageName, version, entries);
  const manifestArtifact = writeCanonicalJson(path.join(projectRoot, 'dist', 'package-manifest.json'), manifest);
  const zipFileName = outputName(version);
  const outputPath = path.join(projectRoot, zipFileName);

  for (const name of fs.readdirSync(projectRoot)) {
    if (name !== zipFileName && /^cc-bridge-3x.*\.zip$/.test(name)) fs.rmSync(path.join(projectRoot, name));
  }
  fs.rmSync(outputPath, { force: true });
  await createZip(outputPath, entries);
  const sidecars = writeReleaseSidecars(projectRoot, outputPath, manifestArtifact, packageName, version);

  console.log(JSON.stringify({
    package: `${packageName}@${version}`,
    zip: outputPath,
    bytes: fs.statSync(outputPath).size,
    sha256: sidecars.zipSha256,
    files: entries.length,
    packageManifestSha256: manifestArtifact.sha256,
    sbomSha256: sidecars.sbom.sha256,
    provenanceSha256: sidecars.provenance.sha256,
    sourceDateEpoch: ZIP_EPOCH_SECONDS,
  }, null, 2));
}

main().catch((error) => {
  console.error(`package failed: ${error.message}`);
  process.exitCode = 1;
});
