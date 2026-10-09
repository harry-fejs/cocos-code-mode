'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

const PACKAGE_NAME = 'ccp3x';
const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function usage() {
  return [
    'Usage: npm run install:package -- --zip <bundle.zip> --project <cocos-project> [--manifest <package-manifest.json>] [--replace]',
    'Shortcut: npm run install:package <bundle.zip> <cocos-project> [--replace]',
    '',
    '--replace  Back up an existing extension directory before installing the bundle.',
  ].join('\n');
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZipEntries(zip) {
  if (zip.length > MAX_ZIP_BYTES) throw new Error('ZIP exceeds the maximum supported size');
  const eocd = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset -= 1) {
    if (zip.readUInt32LE(offset) === eocd) { eocdOffset = offset; break; }
  }
  if (eocdOffset < 0) throw new Error('ZIP end-of-central-directory record is missing');
  const count = zip.readUInt16LE(eocdOffset + 10);
  const centralSize = zip.readUInt32LE(eocdOffset + 12);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > zip.length) throw new Error('ZIP central directory is outside the archive');
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP central directory entry is invalid');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const expandedSize = zip.readUInt32LE(offset + 24);
    const crc = zip.readUInt32LE(offset + 16);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString((flags & 0x800) ? 'utf8' : 'latin1');
    if (expandedSize > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES) throw new Error(`ZIP entry exceeds size limit: ${name}`);
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local entry is invalid: ${name}`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > zip.length) throw new Error(`ZIP entry data is outside the archive: ${name}`);
    entries.push({ name, method, compressedSize, expandedSize, crc, data: zip.subarray(dataOffset, dataOffset + compressedSize) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryBytes(entry) {
  let bytes;
  if (entry.method === 0) bytes = entry.data;
  else if (entry.method === 8) bytes = zlib.inflateRawSync(entry.data);
  else throw new Error(`ZIP compression method is unsupported: ${entry.method}`);
  if (bytes.length !== entry.expandedSize || crc32(bytes) !== entry.crc) throw new Error(`ZIP entry checksum mismatch: ${entry.name}`);
  return bytes;
}

function safeEntryPath(name) {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized.startsWith(`${PACKAGE_NAME}/`) || normalized.startsWith('/') || normalized.includes(':')) {
    throw new Error(`ZIP entry path is unsafe: ${name}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`ZIP entry path is unsafe: ${name}`);
  return normalized;
}

function readManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.package !== PACKAGE_NAME || typeof manifest.version !== 'string') throw new Error('Package manifest identity is invalid');
  const declared = new Map();
  for (const entry of manifest.files || []) {
    if (typeof entry.path !== 'string' || !entry.path.startsWith(`${PACKAGE_NAME}/`) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Package manifest entry is invalid');
    const key = entry.path.toLowerCase();
    if (declared.has(key)) throw new Error(`Package manifest contains duplicate paths: ${entry.path}`);
    declared.set(key, entry);
  }
  return { manifest, declared };
}

function installPackage({ zipPath, projectPath, manifestPath, replace }) {
  const zip = path.resolve(zipPath);
  const project = path.resolve(projectPath);
  if (!fs.statSync(zip).isFile()) throw new Error(`ZIP file does not exist: ${zip}`);
  if (!fs.statSync(project).isDirectory()) throw new Error(`Cocos project directory does not exist: ${project}`);
  const manifestFile = path.resolve(manifestPath || path.join(path.dirname(zip), 'dist', 'package-manifest.json'));
  if (!fs.statSync(manifestFile).isFile()) throw new Error(`Package manifest does not exist: ${manifestFile}`);
  const { manifest, declared } = readManifest(manifestFile);
  const entries = readZipEntries(fs.readFileSync(zip));
  const actual = new Map();
  const extensions = path.join(project, 'extensions');
  const destination = path.join(extensions, PACKAGE_NAME); for (const legacy of ['cc-bridge-3x', 'cocos-pilot-3x']) if (fs.existsSync(path.join(extensions, legacy))) throw new Error(`Legacy extension ${legacy} is still installed; close Creator and preserve it outside extensions before installing CCP (no double loading).`);
  const staging = path.join(extensions, `.ccp3x-install-${process.pid}-${Date.now()}`);
  let backup;
  try {
    fs.mkdirSync(extensions, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      const normalized = safeEntryPath(entry.name);
      const key = normalized.toLowerCase();
      if (actual.has(key)) throw new Error(`ZIP contains duplicate paths: ${normalized}`);
      const expected = declared.get(key);
      if (!expected) throw new Error(`ZIP entry is not declared by the package manifest: ${normalized}`);
      const bytes = entryBytes(entry);
      if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) throw new Error(`ZIP entry digest mismatch: ${normalized}`);
      const target = path.join(staging, ...normalized.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: expected.mode || 0o644 });
      actual.set(key, true);
    }
    if (actual.size !== declared.size) throw new Error('ZIP entry set differs from the package manifest');
    if (!fs.existsSync(path.join(staging, 'ccp3x', 'package.json')) || !fs.existsSync(path.join(staging, 'ccp3x', 'dist', 'main.js'))) throw new Error('Package is missing package.json or dist/main.js');
    if (fs.existsSync(destination)) {
      if (!replace) throw new Error(`Extension destination already exists: ${destination}. Re-run with --replace after closing Creator.`);
      backup = `${destination}.imported-backup-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
      fs.renameSync(destination, backup);
    }
    fs.renameSync(path.join(staging, PACKAGE_NAME), destination);
    fs.rmSync(staging, { recursive: true, force: true });
    return { status: 'installed', package: manifest.package, version: manifest.version, destination, backup: backup || null, zipSha256: sha256(fs.readFileSync(zip)), manifestSha256: sha256(fs.readFileSync(manifestFile)), next: 'Close and reload Cocos Creator before testing.' };
  } catch (error) {
    if (backup && !fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination);
    throw error;
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const namedZipPath = option(args, '--zip');
  const namedProjectPath = option(args, '--project');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const zipPath = namedZipPath || positional[0];
  const projectPath = namedProjectPath || positional[1];
  const manifestPath = option(args, '--manifest');
  if (!zipPath || !projectPath || args.includes('--help')) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(installPackage({ zipPath, projectPath, manifestPath, replace: args.includes('--replace') })));
    } catch (error) {
      console.error(`install-package failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { installPackage, readZipEntries, entryBytes, safeEntryPath };
