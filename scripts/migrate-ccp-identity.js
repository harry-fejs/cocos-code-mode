#!/usr/bin/env node
'use strict';
// Legacy names in this file are migration inputs, never runtime aliases.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomBytes } = require('node:crypto');
const { readUtcpConfig, withConfigLock, writeUtcpConfig, writeBytesAtomic } = require('../dist/utcp/config-store');
const { assertConnectionConfig, canonicalProjectPath, LegacyConnectionStateSchema, ownerIsAlive, storeConnectionState } = require('../dist/utcp/project-connection');
const { ensurePrivateDirectory } = require('../dist/protected/durable-file');
const OLD_PACKAGES = ['cc-bridge-3x', 'cocos-pilot-3x'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => { const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value); return normalize(a) === normalize(b); };
function regular(file, max = 4 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error(`unsafe or unbounded file: ${file}`);
  return fs.readFileSync(file);
}
function noLinks(target) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`symbolic path refused: ${current}`);
    if (path.dirname(current) === current) break;
  }
}
function offline(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const fail = () => { socket.destroy(); reject(new Error(`port ${port} is occupied or unverifiable; close Creator before migration`)); };
    socket.once('connect', fail);
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(new Error(`port ${port} ownership is unverifiable`)); });
    socket.setTimeout(800, fail);
  });
}
function inventory(root) {
  const files = []; let total = 0;
  function walk(directory, depth) {
    if (depth > 12) throw new Error('state tree exceeds migration depth bound');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic state entry refused: ${file}`);
      if (entry.isDirectory()) walk(file, depth + 1);
      else {
        const bytes = regular(file, 16 * 1024 * 1024); if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077)) throw new Error('legacy state file is not user-private');
        total += bytes.length;
        if (files.length >= 2048 || total > 64 * 1024 * 1024) throw new Error('state exceeds 2048-file/64MiB migration bound');
        if (/\.(db|sqlite|sqlite3)(-wal|-shm)?$/i.test(file) || /signer.*\.sock$/i.test(file)) throw new Error('Gateway database/socket migration requires a separately owned stopped Gateway and fresh CCP enrollment; refused');
        files.push({ relative: path.relative(root, file), bytes, digest: sha(bytes) });
      }
    }
  }
  walk(root, 0); return files;
}
function assertNoOldExtension(projectPath) {
  for (const name of OLD_PACKAGES) {
    if (fs.existsSync(path.join(projectPath, 'extensions', name))) throw new Error(`legacy extension ${name} is still installed; close Creator, back it up outside extensions, and install a freshly signed ccp3x release before migration`);
  }
}
async function migrateIdentity({ configPath, stateRoot, apply = false }) {
  if (fs.existsSync(`${configPath}.ccb-lock`)) throw new Error('legacy config writer lock exists; close and verify the owner before migration'); if (!configPath || !stateRoot) throw new Error('explicit --config and --state-root are required; no user-home inference');
  configPath = path.resolve(configPath); stateRoot = path.resolve(stateRoot);
  noLinks(configPath); noLinks(stateRoot);
  if (!same(stateRoot, path.join(path.dirname(configPath), '.cc-bridge'))) throw new Error('state root must be the legacy registry root owned by this exact config');
  const destination = path.join(path.dirname(configPath), '.ccp');
  if (fs.existsSync(destination)) throw new Error('CCP state destination already exists; refusing merge or overwrite');
  const configBytes = regular(configPath);
  const config = readUtcpConfig(configPath); if (config.manual_call_templates.length > 512 || (config.load_variables_from || []).length > 512) throw new Error('config exceeds 512 registration bound');
  const files = inventory(stateRoot);
  const registryPath = path.join(stateRoot, 'project-connections.json'); const embeddedOld = config.variables?.CCB_PROJECT_CONNECTIONS; const embeddedCurrent = config.variables?.CCP_PROJECT_CONNECTIONS; if (embeddedOld !== undefined && embeddedCurrent !== undefined) throw new Error('conflicting embedded registry identities'); const embedded = embeddedOld ?? embeddedCurrent; const legacy = embedded === undefined ? null : LegacyConnectionStateSchema.parse(JSON.parse(embedded)); const registry = fs.existsSync(registryPath) ? JSON.parse(regular(registryPath)) : legacy ? { version: 1, configPath, projects: legacy.projects } : null;
  if (!registry || registry.version !== 1 || !same(registry.configPath, configPath) || !registry.projects || Object.keys(registry.projects).length === 0 || Object.keys(registry.projects).length > 512) throw new Error('registry ownership/version/bound is unverifiable');
  if (legacy && JSON.stringify(legacy.projects) !== JSON.stringify(registry.projects)) throw new Error('embedded and external registries conflict; no files changed');
  const nextConfig = structuredClone(config); if (nextConfig.variables) { delete nextConfig.variables.CCB_PROJECT_CONNECTIONS; delete nextConfig.variables.CCP_PROJECT_CONNECTIONS; }
  const nextState = structuredClone(registry);
  const migrated = new Set(); const registrations = new Set(); const credentialPaths = new Set();
  const copiedCredentials = [];
  for (const [id, connection] of Object.entries(nextState.projects)) {
    if (canonicalProjectPath(connection.projectPath) !== connection.projectPath || sha(connection.projectPath) !== id || connection.projectId !== id) throw new Error('canonical project ownership cannot be verified');
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !Number.isInteger(connection.ownerPid) || connection.ownerPid <= 0) throw new Error('invalid owner/port identity');
    if (ownerIsAlive(connection.ownerPid)) throw new Error('registered owner is running or unverifiable; migration refused');
    await offline(connection.port);
    assertNoOldExtension(connection.projectPath);
    const expected = path.join(stateRoot, 'local-auth', `${id}.env`);
    if (!same(connection.tokenPath, expected)) throw new Error('credential is outside the owned state root; separate credential-root ownership is required and this migration refuses it');
    const credential = regular(expected, 4096).toString('utf8');
    const namespace = `ccp3x__${connection.port}_`;
    const oldNamespace = `ccb3x__${connection.port}_`;
    const values = Object.fromEntries(credential.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
    const prefix = values[`${namespace}CCB_LOCAL_TOKEN`] ? namespace : oldNamespace;
    const allowed = ['CCB_RELAY_INSTANCE_ID', 'CCB_LOCAL_TOKEN', 'CCB_BOUND_PORT', 'CCB_LOCAL_PROJECT_ID'];
    if (Object.keys(values).length !== 4 || allowed.some(key => !Object.hasOwn(values, prefix + key)) || values[prefix + 'CCB_RELAY_INSTANCE_ID'] !== connection.relayInstanceId || values[prefix + 'CCB_BOUND_PORT'] !== String(connection.port) || values[prefix + 'CCB_LOCAL_PROJECT_ID'] !== id || !/^[A-Za-z0-9_-]{43}$/.test(values[prefix + 'CCB_LOCAL_TOKEN'])) throw new Error('credential/project/session ownership cannot be verified');
    if (Object.keys(config.variables || {}).some(key => key.startsWith(namespace) || key.startsWith(oldNamespace))) throw new Error('inline credentials conflict with owned loader');
    const target = path.join(destination, 'local-auth', `${id}.env`);
    copiedCredentials.push({ target, content: '# Migrated offline to CCP; next start rotates credentials.\n' + allowed.map(key => `${namespace}${key.replace('CCB_', 'CCP_')}=${values[prefix + key]}`).join('\n') + '\n' });
    const templates = nextConfig.manual_call_templates.filter(entry => ['ccb3x_' + connection.port, 'ccp3x_' + connection.port].includes(entry.name));
    const loaders = (nextConfig.load_variables_from || []).filter(entry => entry.variable_loader_type === 'dotenv' && same(entry.env_file_path || '', expected));
    if (connection.active ? templates.length !== 1 || loaders.length !== 1 || templates[0].url !== `http://localhost:${connection.port}/utcp` : templates.length !== 0 || loaders.length !== 0) throw new Error('registry and config registrations conflict');
    for (const template of templates) registrations.add(template);
    for (const loader of loaders) credentialPaths.add(loader);
    connection.tokenPath = target;
    // Never reactivate dead sessions; retain only dedicated project/port reservations.
    connection.active = false;
    migrated.add(id);
  }
  if (nextConfig.manual_call_templates.some(entry => /^(?:ccb3x|ccp3x)(?:_|$)/.test(entry.name) && !registrations.has(entry))) throw new Error('unowned or bare Cocos manual remains; migration refused');
  if ((nextConfig.load_variables_from || []).some(entry => entry.variable_loader_type === 'dotenv' && path.resolve(entry.env_file_path || '').startsWith(stateRoot + path.sep) && !credentialPaths.has(entry))) throw new Error('unowned legacy credential loader remains; migration refused');
  nextConfig.manual_call_templates = nextConfig.manual_call_templates.filter(entry => !registrations.has(entry));
  nextConfig.load_variables_from = (nextConfig.load_variables_from || []).filter(entry => !credentialPaths.has(entry));
  assertConnectionConfig(nextConfig, nextState);
  const report = { mode: apply ? 'apply' : 'dry-run', configPath, stateRoot, destination, projects: migrated.size, credentials: copiedCredentials.length, backup: null, oldSignedContent: 'preserved byte-for-byte under legacy-signed-state, not active trust', freshEnrollmentAndSignedReleaseRequired: true, legacyQuarantinedCount: legacy?.quarantined?.length || 0, profileMigration: 'refused: Editor.Profile ownership unavailable offline; configure CCP profile explicitly' };
  if (!apply) return report;
  // Recheck identity/liveness immediately before lock-protected backup/publication.
  for (const connection of Object.values(registry.projects)) { if (ownerIsAlive(connection.ownerPid)) throw new Error('owner started during migration'); await offline(connection.port); assertNoOldExtension(connection.projectPath); }
  return withConfigLock(configPath, () => {
    if (fs.existsSync(`${configPath}.ccb-lock`) || !regular(configPath).equals(configBytes) || fs.existsSync(destination)) throw new Error('config/destination changed; run dry-run again');
    const current = inventory(stateRoot);
    if (JSON.stringify(current.map(file => [file.relative, file.digest])) !== JSON.stringify(files.map(file => [file.relative, file.digest]))) throw new Error('state changed; run dry-run again');
    const backup = `${stateRoot}.backup-${Date.now()}-${randomBytes(4).toString('hex')}`;
    fs.mkdirSync(backup, { mode: 0o700 }); ensurePrivateDirectory(backup);
    writeBytesAtomic(path.join(backup, 'utcp-config.json'), configBytes);
    for (const file of files) { const target = path.join(backup, 'state', file.relative); ensurePrivateDirectory(path.dirname(target)); writeBytesAtomic(target, file.bytes); }
    fs.mkdirSync(destination, { mode: 0o700 }); ensurePrivateDirectory(destination);
    // Noncredential legacy state is archival only. In particular never activate old signed root/identity/release bytes.
    for (const file of files) if (file.relative !== 'project-connections.json' && !file.relative.startsWith('local-auth' + path.sep)) {
      const target = path.join(destination, 'legacy-signed-state', file.relative); ensurePrivateDirectory(path.dirname(target)); writeBytesAtomic(target, file.bytes);
    }
    for (const credential of copiedCredentials) { ensurePrivateDirectory(path.dirname(credential.target)); writeBytesAtomic(credential.target, Buffer.from(credential.content)); }
    storeConnectionState(configPath, nextState);
    report.backup = backup;
    writeBytesAtomic(path.join(destination, 'identity-migration.json'), Buffer.from(JSON.stringify(report, null, 2) + '\n'));
    // Config publishes last; any interrupted migration leaves a destination conflict and fails closed for manual reconciliation.
    writeUtcpConfig(configPath, nextConfig);
    return report;
  });
}
if (require.main === module) {
  const options = { apply: false }; const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--config' || arg === '--state-root') { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`); options[arg === '--config' ? 'configPath' : 'stateRoot'] = value; }
    else if (arg === '--apply') options.apply = true;
    else if (arg !== '--dry-run') throw new Error(`unknown argument ${arg}`);
  }
  if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('choose dry-run or apply');
  migrateIdentity(options).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { migrateIdentity };
