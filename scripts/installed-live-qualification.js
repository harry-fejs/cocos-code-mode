'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX = 8 * 1024 * 1024;
const SURFACES = ['gateway-db-snapshot', 'gateway-logs', 'metrics', 'relay-logs', 'update-state', 'support-bundle'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(file, max = MAX) {
  if (!path.isAbsolute(file)) throw new Error('evidence paths must be absolute');
  for (let p = file; ; p = path.dirname(p)) { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('evidence path traverses a link'); if (path.dirname(p) === p) break; }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > max) throw new Error('evidence must be a bounded regular file');
  return fs.readFileSync(file);
}
const json = file => JSON.parse(read(file).toString('utf8'));
function write(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > MAX || !path.isAbsolute(file)) throw new Error('invalid output path or size');
  for (let p = path.dirname(file); ; p = path.dirname(p)) { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('output path traverses a link'); if (path.dirname(p) === p) break; }
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}
function installed(config) {
  const { canonicalizeToBytes } = require('../dist/protected/canonical-json');
  const { RootBodySchema, verifyReleaseMetadata } = require('../dist/update/metadata');
  const trustedBytes = read(config.trustedRootPath, 256 * 1024);
  if (sha(trustedBytes) !== config.trustedRootSha256) throw new Error('trusted root pin mismatch');
  const root = RootBodySchema.parse(JSON.parse(trustedBytes));
  if (!canonicalizeToBytes(root).equals(trustedBytes)) throw new Error('trusted root must be canonical payload');
  const verified = {};
  for (const [kind, role, name] of [['root', 'root', 'root.signed.json'], ['target', 'targets', 'target.signed.json'], ['policy', 'policy', 'policy.signed.json']]) {
    const keys = new Map(root.roles[role].keyIds.map(id => [id, crypto.createPublicKey({ key: Buffer.from(root.keys[id].spkiDer, 'base64url'), format: 'der', type: 'spki' })]));
    const wrapper = json(path.join(config.releaseDirectory, name));
    verified[kind] = { body: verifyReleaseMetadata(kind, wrapper, keys, root.roles[role].threshold), digest: sha(Buffer.from(wrapper.payload, 'base64url')) };
  }
  if (verified.root.digest !== config.trustedRootSha256) throw new Error('release root is not the pinned trusted root');
  for (const entry of [root, verified.target.body, verified.policy.body]) if (Date.parse(entry.issuedAt) > Date.now() || Date.parse(entry.expiresAt) <= Date.now()) throw new Error('release metadata not currently active');
  const descriptorBytes = read(path.join(config.installedDirectory, '.ccp-staged.json'));
  const descriptor = JSON.parse(descriptorBytes);
  const target = verified.target.body.package;
  if (descriptor.schemaVersion !== 1 || descriptor.packageSha256 !== target.sha256 || descriptor.packageBytes !== target.size || descriptor.version !== target.version || descriptor.targetPayloadSha256 !== verified.target.digest || descriptor.policyPayloadSha256 !== verified.policy.digest || verified.policy.body.targetPayloadSha256 !== verified.target.digest) throw new Error('installed descriptor is not bound to signed release');
  for (const [name, field] of [['root.signed.json', 'rootMetadataSha256'], ['target.signed.json', 'targetMetadataSha256'], ['policy.signed.json', 'policyMetadataSha256'], ['release.zip', 'packageSha256'], ['package-manifest.json', 'packageManifestSha256'], ['sbom.cdx.json', 'sbomSha256'], ['provenance.intoto.json', 'provenanceSha256']]) {
    const bytes = read(path.join(config.releaseDirectory, name), 128 * 1024 * 1024);
    if (sha(bytes) !== descriptor[field] || (name === 'release.zip' && bytes.length !== target.size)) throw new Error('release artifact mismatch: ' + name);
    if (Object.hasOwn(target, field) && target[field] !== descriptor[field]) throw new Error('signed artifact binding mismatch');
  }
  const manifestBytes = read(path.join(config.installedDirectory, '.ccp-package-manifest.json'));
  if (sha(manifestBytes) !== target.packageManifestSha256) throw new Error('installed manifest mismatch');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.package !== 'ccp3x' || manifest.version !== target.version || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 4096) throw new Error('invalid installed manifest');
  const expected = new Set(); let total = 0;
  for (const file of manifest.files) {
    const prefix = 'ccp3x/';
    if (!file.path.startsWith(prefix)) throw new Error('manifest file outside package');
    const rel = file.path.slice(prefix.length);
    if (!rel || rel.split('/').some(p => !p || p === '.' || p === '..') || rel.includes('\\') || rel.includes(':') || expected.has(rel)) throw new Error('unsafe or duplicate manifest path');
    expected.add(rel);
    const bytes = read(path.join(config.installedDirectory, rel), 32 * 1024 * 1024); total += bytes.length;
    if (total > 128 * 1024 * 1024 || bytes.length !== file.size || sha(bytes) !== file.sha256) throw new Error('installed signed file mismatch');
  }
  function walk(directory, depth = 0) {
    if (depth > 32) throw new Error('installed tree depth exceeded');
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name); const rel = path.relative(config.installedDirectory, file).replaceAll('\\', '/');
      if (item.isSymbolicLink()) throw new Error('installed tree contains link');
      if (item.isDirectory()) walk(file, depth + 1);
      else if (!item.isFile() || (!expected.delete(rel) && !['.ccp-staged.json', '.ccp-package-manifest.json'].includes(rel))) throw new Error('installed unsigned file');
    }
  }
  walk(config.installedDirectory);
  if (expected.size) throw new Error('installed files missing');
  const build = json(path.join(config.installedDirectory, 'dist/build-info.json'));
  return { descriptorSha256: sha(descriptorBytes), packageHash: target.sha256, targetPayloadHash: verified.target.digest, version: target.version, build, installedFiles: manifest.files.length };
}
function signedEvents(file, identity, runId, packageBinding) {
  const bytes = read(file);
  const lines = bytes.toString('utf8').trim().split(/\r?\n/);
  if (!bytes.length || lines.length > 1024) throw new Error('missing or excessive signed live events');
  const keyBytes = Buffer.from(identity.publicKeyDer, 'base64url');
  if (identity.deviceKeyId !== 'device-' + sha(keyBytes).slice(0, 24)) throw new Error('invalid live identity key binding');
  const key = crypto.createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
  const events = lines.map(line => {
    const wrapper = JSON.parse(line);
    if (wrapper.keyId !== identity.deviceKeyId || typeof wrapper.payload !== 'string' || typeof wrapper.signature !== 'string') throw new Error('unsigned or source-only live event');
    const payload = Buffer.from(wrapper.payload, 'base64');
    if (!crypto.verify(null, Buffer.concat([Buffer.from('CCP1 installed-live-witness\n'), payload]), key, Buffer.from(wrapper.signature, 'base64'))) throw new Error('forged live event signature');
    const event = JSON.parse(payload);
    if (event.schemaVersion !== 1 || event.evidenceScope !== 'installed-live' || event.runId !== runId || event.binding.deviceId !== identity.deviceId || event.binding.publicKeyDer !== identity.publicKeyDer || event.binding.packageHash !== packageBinding.packageHash || event.binding.targetPayloadHash !== packageBinding.targetPayloadHash || !Array.isArray(event.evidenceErrors) || event.evidenceErrors.length) throw new Error('live event binding or evidence errors');
    return event;
  });
  return { events, sha256: sha(bytes) };
}
function scan(config, controls) {
  const markers = config.markersPath ? json(config.markersPath) : [];
  if (!Array.isArray(markers) || !markers.length || markers.length > 32 || new Set(markers.map(m => m.label)).size !== markers.length || markers.some(m => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(m.label) || typeof m.value !== 'string' || Buffer.byteLength(m.value) < 8 || Buffer.byteLength(m.value) > 256 || !Array.isArray(m.allowedSurfaces) || m.allowedSurfaces.some(name => !SURFACES.includes(name)) || typeof m.allowedInGatewayRequest !== 'boolean' || !['operation-input', 'creator-observation', 'local-result'].includes(m.sourceKind))) throw new Error('live canary configuration unavailable or invalid');
  const configured = config.surfacesPath ? json(config.surfacesPath) : null;
  const surfaces = Array.isArray(configured) ? configured : configured?.surfaces;
  if (!Array.isArray(surfaces) || surfaces.length !== SURFACES.length) throw new Error('required live scan surfaces unavailable');
  const roots = surfaces.map(s => fs.realpathSync(s.root));
  for (let a = 0; a < roots.length; a++) for (let b = 0; b < a; b++) {
    const rel = path.relative(roots[a], roots[b]); const reverse = path.relative(roots[b], roots[a]);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel)) || (!reverse.startsWith('..') && !path.isAbsolute(reverse))) throw new Error('surface roots overlap');
  }
  let total = 0; let count = 0; const reports = [];
  for (const name of SURFACES) {
    const matches = surfaces.filter(s => s.name === name); if (matches.length !== 1 || !path.isAbsolute(matches[0].root)) throw new Error('missing or duplicate required surface: ' + name);
    const root = fs.realpathSync(matches[0].root);
    if (controls.some(c => { const rel = path.relative(root, c); return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)); })) throw new Error('scan includes evidence controls');
    const files = [];
    function walk(directory, depth = 0) {
      if (depth > 32 || fs.lstatSync(directory).isSymbolicLink()) throw new Error('unsafe surface tree');
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        else {
          const bytes = read(file, 32 * 1024 * 1024); total += bytes.length; count++;
          if (!bytes.length) throw new Error('empty surface evidence file');
          if (total > 128 * 1024 * 1024 || count > 4096) throw new Error('surface scan bound exceeded');
          const markerCounts = {};
          for (const marker of markers) {
            const needle = Buffer.from(marker.value); let n = 0; let p = 0;
            while ((p = bytes.indexOf(needle, p)) >= 0) { n++; p += needle.length; }
            markerCounts[marker.label] = n;
            if (n && !marker.allowedSurfaces.includes(name)) throw new Error('forbidden canary on surface: ' + name);
          }
          files.push({ fileId: sha(path.relative(root, file)), bytes: bytes.length, sha256: sha(bytes), markerCounts });
        }
      }
    }
    walk(root); if (!files.length) throw new Error('empty required surface: ' + name);
    reports.push({ name, files });
  }
  return { reports, markers };
}
module.exports = { sha, read, json, write, installed, signedEvents, scan };
