'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { isFixedAclModule } = require('./fixed-acl-witness');

const TRACKED_ROOTS = ['@types', 'i18n', 'static'];
const TRACKED_FILES = ['package-lock.json', 'scripts/install-update.ps1'];
const GENERATED_OUTPUT_FILES = new Set(['dist/build-info.json']);
const GENERATED_SIDECARS = new Set([
  'dist/package-manifest.json',
  'dist/sbom.cdx.json',
  'dist/provenance.intoto.json',
  'dist/release-target.signed.json',
  'dist/.rename-map.json',
]);
const FORBIDDEN_SUFFIXES = ['.map', '.tsbuildinfo'];

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedMode(stat) {
  return stat.mode & 0o111 ? 0o755 : 0o644;
}

function assertOrdinaryFile(fsPath, stat) {
  if (stat.isSymbolicLink()) throw new Error(`package input must not be a symlink: ${fsPath}`);
  if (!stat.isFile()) throw new Error(`package input must be a regular file: ${fsPath}`);
}

function shouldInclude(relativePath) {
  const posixPath = toPosix(relativePath);
  return !GENERATED_SIDECARS.has(posixPath)
    && !FORBIDDEN_SUFFIXES.some((suffix) => posixPath.endsWith(suffix));
}

function collectTree(projectRoot, relativeRoot, entries, options = {}) {
  const absoluteRoot = path.join(projectRoot, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) throw new Error(`required package input missing: ${relativeRoot}`);
  const walk = (absolutePath, relativePath) => {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`package input must not be a symlink: ${relativePath}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) {
        if (options.skipNestedNodeModules && name === 'node_modules') continue;
        if (options.skipVendorNoise && /^(?:test|tests|__tests__|example|examples|fixture|fixtures|\.github)$/i.test(name)) continue;
        walk(path.join(absolutePath, name), path.join(relativePath, name));
      }
      return;
    }
    assertOrdinaryFile(relativePath, stat);
    if (!shouldInclude(relativePath)) return;
    const bytes = fs.readFileSync(absolutePath);
    entries.push({
      sourcePath: absolutePath,
      relativePath: toPosix(relativePath),
      size: bytes.length,
      sha256: sha256(bytes),
      mode: normalizedMode(stat),
    });
  };
  walk(absoluteRoot, relativeRoot);
}
function listOrdinaryFiles(projectRoot, relativeRoot) {
  const files = [];
  const absoluteRoot = path.join(projectRoot, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) throw new Error(`required package input missing: ${relativeRoot}`);
  const walk = (absolutePath, relativePath) => {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`package input must not be a symlink: ${relativePath}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) {
        walk(path.join(absolutePath, name), path.join(relativePath, name));
      }
      return;
    }
    assertOrdinaryFile(relativePath, stat);
    if (shouldInclude(relativePath)) files.push(toPosix(relativePath));
  };
  walk(absoluteRoot, relativeRoot);
  return files;
}

function gitTrackedFiles(projectRoot) {
  const result = spawnSync('git', [
    'ls-files',
    '-z',
    '--',
    'source/**',
    '@types/**',
    'i18n/**',
    'static/**',
    'package-lock.json',
    'scripts/install-update.ps1',
  ], { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('cannot derive package inventory from tracked files');
  return result.stdout.split('\0').filter(Boolean).map(toPosix);
}

function declaredGeneratedOutputs(projectRoot, trackedFiles) {
  const renameMapPath = path.join(projectRoot, 'dist', '.rename-map.json');
  if (!fs.existsSync(renameMapPath)) throw new Error('generated output declaration is missing: dist/.rename-map.json');
  const parsed = JSON.parse(fs.readFileSync(renameMapPath, 'utf8'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
    || !Object.entries(parsed).every(([from, to]) => typeof from === 'string' && typeof to === 'string')) {
    throw new Error('generated output declaration is invalid');
  }
  const originalOutputs = new Set(trackedFiles
    .filter((file) => file.startsWith('source/') && file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.startsWith('source/utcp/execute/'))
    .map((file) => file.slice('source/'.length, -'.ts'.length) + '.js'));
  for (const file of trackedFiles.filter((candidate) => candidate.startsWith('source/') && candidate.endsWith('.json'))) {
    originalOutputs.add(file.slice('source/'.length));
  }
  for (const from of Object.keys(parsed)) {
    if (!originalOutputs.has(from)) throw new Error(`generated output declaration references an unknown source output: dist/${from}`);
  }
  const outputs = new Set(GENERATED_OUTPUT_FILES);
  for (const original of originalOutputs) {
    const emitted = parsed[original] ?? original;
    const normalized = path.posix.normalize(emitted);
    if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')
      || (path.posix.extname(normalized) !== '.js' && path.posix.extname(normalized) !== '.json')) {
      throw new Error(`generated output declaration contains an unsafe path: ${emitted}`);
    }
    const output = `dist/${normalized}`;
    if (outputs.has(output)) throw new Error(`generated output declaration contains a collision: ${output}`);
    outputs.add(output);
  }
  return [...outputs].sort();
}

function resolvePackageInputClosure(projectRoot, options = {}) {
  const trackedFiles = (options.trackedFiles ?? gitTrackedFiles(projectRoot)).map(toPosix);
  const trackedSet = new Set(trackedFiles);
  const trackedPackageFiles = trackedFiles.filter((file) => TRACKED_FILES.includes(file)
    || TRACKED_ROOTS.some((root) => file.startsWith(`${root}/`)));
  for (const root of TRACKED_ROOTS) {
    for (const actual of listOrdinaryFiles(projectRoot, root)) {
      if (!trackedSet.has(actual)) throw new Error(`untracked packaged input: ${actual}`);
    }
  }
  const generatedOutputs = (options.generatedOutputs ?? declaredGeneratedOutputs(projectRoot, trackedFiles)).map(toPosix);
  const generatedSet = new Set(generatedOutputs);
  for (const actual of listOrdinaryFiles(projectRoot, 'dist')) {
    if (!generatedSet.has(actual)) throw new Error(`undeclared generated packaged input: ${actual}`);
  }
  for (const expected of generatedOutputs) {
    if (!fs.existsSync(path.join(projectRoot, expected))) throw new Error(`declared generated package input missing: ${expected}`);
  }
  return { trackedPackageFiles: trackedPackageFiles.sort(), generatedOutputs: [...generatedSet].sort() };
}


function productionPackageRoots(projectRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json must use lockfileVersion 3 with a packages map');
  }
  return Object.entries(lock.packages)
    .filter(([packagePath, metadata]) => packagePath.startsWith('node_modules/') && metadata && metadata.dev !== true)
    .map(([packagePath]) => packagePath)
    .sort();
}

function assignArchivePaths(entries, packageName) {
  const seen = new Set();
  for (const entry of entries) {
    const archivePath = `${packageName}/${entry.relativePath}`;
    const collisionKey = archivePath.toLocaleLowerCase('en-US');
    if (seen.has(collisionKey)) throw new Error(`case-colliding package path: ${archivePath}`);
    seen.add(collisionKey);
    entry.archivePath = archivePath;
  }
}

function collectPackageEntries(projectRoot, packageName, patchedPackageJson, options = {}) {
  const entries = [];
  const closure = resolvePackageInputClosure(projectRoot, options);
  for (const relativeFile of closure.trackedPackageFiles) collectTree(projectRoot, relativeFile, entries);
  for (const relativeFile of closure.generatedOutputs) collectTree(projectRoot, relativeFile, entries);
  for (const packageRoot of productionPackageRoots(projectRoot)) {
    collectTree(projectRoot, packageRoot, entries, { skipNestedNodeModules: true, skipVendorNoise: true });
  }

  const packageBytes = Buffer.from(JSON.stringify(patchedPackageJson, null, 2));
  entries.push({
    sourcePath: null,
    bytes: packageBytes,
    relativePath: 'package.json',
    size: packageBytes.length,
    sha256: sha256(packageBytes),
    mode: 0o644,
  });

  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  assignArchivePaths(entries, packageName);
  return entries;
}

function createPackageManifest(packageName, version, entries) {
  return {
    schemaVersion: 1,
    package: packageName,
    version,
    files: entries.map(({ archivePath, size, sha256: digest, mode }) => ({
      path: archivePath,
      size,
      sha256: digest,
      mode,
    })),
  };
}

const FORBIDDEN_ARCHIVE_PATH = /(?:^|\/)(?:\.env(?:\.|$)|[^/]*(?:private[-_]?key|credential|secret)[^/]*)/i;
const NESTED_ARCHIVE = /\.(?:zip|tgz|tar|gz|7z|rar|asar)$/i;
const SECRET_TEXT = [
  /CCB_(?:EXECUTION|RELEASE|DEVICE)[A-Z0-9_]*PRIVATE_KEY/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const FIRST_PARTY_FORBIDDEN_TEXT = [
  /sourceMappingURL=data:/,
  /"sourcesContent"\s*:/,
  /\bexecuteJavascript\b/,
  /\bplanCreateUiNode\b/,
  /\bnew Function\s*\(/,
  /\beval\s*\(/,
];

function isVendorPath(relativePath) {
  return relativePath.startsWith('node_modules/');
}

function isVendorDoc(relativePath) {
  return isVendorPath(relativePath) && /\.(?:md|markdown|txt)$/i.test(relativePath);
}

function assertReleaseInventory(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('release inventory is empty');
  let fixedActivationLaunchers = 0;
  for (const entry of entries) {
    if (!isVendorPath(entry.relativePath) && FORBIDDEN_ARCHIVE_PATH.test(entry.archivePath)) {
      throw new Error(`sensitive package path: ${entry.archivePath}`);
    }
    if (NESTED_ARCHIVE.test(entry.archivePath)) throw new Error(`nested archive is not allowed: ${entry.archivePath}`);
    if (isVendorDoc(entry.relativePath)) continue;
    const bytes = entry.bytes || fs.readFileSync(entry.sourcePath);
    if (entry.relativePath === options.approvedAclOutput
        && !isFixedAclModule(entry.relativePath, bytes, options.approvedAclOutput)) {
      throw new Error(`unapproved fixed ACL implementation in ${entry.archivePath}`);
    }
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    const isVendorPathname = isVendorPath(entry.relativePath);
    if (/(?:node:)?child_process/.test(text) && !isVendorPathname
        && !isFixedAclModule(entry.relativePath, bytes, options.approvedAclOutput)) {
      if (!/powershell\.exe/i.test(text) || !/install-update\.ps1/i.test(text) || /\b(?:exec|execFile|fork)\s*\(/.test(text) || /shell\s*:\s*(?:true|!0)/.test(text)) {
        throw new Error(`general process launcher in ${entry.archivePath}`);
      }
      fixedActivationLaunchers += 1;
    }
    const patterns = isVendorPath(entry.relativePath)
      ? SECRET_TEXT
      : SECRET_TEXT.concat(FIRST_PARTY_FORBIDDEN_TEXT);
    for (const pattern of patterns) {
      if (pattern.source === '\\bexecuteJavascript\\b' && text.includes('REMOVED_CUSTOMER_TOOLS')) continue;
      if (pattern.test(text)) throw new Error(`forbidden release marker ${pattern} in ${entry.archivePath}`);
    }
  }
  if (fixedActivationLaunchers > 1 || (options.requireActivationLauncher === true && fixedActivationLaunchers !== 1)) {
    throw new Error(`expected one fixed activation launcher, found ${fixedActivationLaunchers}`);
  }
}

module.exports = {
  assignArchivePaths,
  assertReleaseInventory,
  collectPackageEntries,
  createPackageManifest,
  productionPackageRoots,
  sha256,
};
