#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { readUtcpConfig, withConfigLock, writeUtcpConfig, writeJsonAtomic } = require('../dist/utcp/config-store');
const { assertConnectionConfig, connectionRegistryPath, migrationReportsPath, LegacyConnectionStateSchema, readConnectionState, storeConnectionState } = require('../dist/utcp/project-connection');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.env$/i;
function legacyPort(loader) {
  if (loader.variable_loader_type !== 'dotenv' || typeof loader.env_file_path !== 'string') return null;
  const target = path.resolve(loader.env_file_path);
  const parent = path.resolve(os.homedir(), '.cc-bridge', 'local-auth');
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(path.dirname(target)) !== normalize(parent) || !UUID.test(path.basename(target))) return null;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) throw new Error('legacy credential file is not a bounded regular file');
  const text = fs.readFileSync(target, 'utf8');
  const id = /^CCB_RELAY_INSTANCE_ID=([a-f0-9-]+)$/im.exec(text)?.[1];
  const port = Number(/^CCB_BOUND_PORT=(\d+)$/m.exec(text)?.[1]);
  if (!id || `${id}.env`.toLowerCase() !== path.basename(target).toLowerCase() || !/^CCB_LOCAL_TOKEN=[A-Za-z0-9_-]{43}$/m.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}
function endpointState(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (state) => { if (!done) { done = true; socket.destroy(); resolve(state); } };
    socket.once('connect', () => finish('occupied'));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'offline' : 'unknown'));
    socket.setTimeout(800, () => finish('unknown'));
  });
}
async function migrate(configPath, apply) {
  const { config, state: external } = withConfigLock(configPath, () => ({ config: readUtcpConfig(configPath), state: readConnectionState(configPath) }));
  const snapshot = JSON.stringify(config);
  const registrySnapshot = JSON.stringify(external);
  if (config.variables?.CCB_PROJECT_CONNECTIONS !== undefined && config.variables?.CCP_PROJECT_CONNECTIONS !== undefined) throw new Error('conflicting legacy/current embedded registries'); const embedded = config.variables?.CCP_PROJECT_CONNECTIONS ?? config.variables?.CCB_PROJECT_CONNECTIONS;
  const legacy = embedded === undefined ? null : LegacyConnectionStateSchema.parse(JSON.parse(embedded));
  const state = { ...external, projects: { ...external.projects } };
  for (const [id, connection] of Object.entries(legacy?.projects || {})) {
    if (state.projects[id] && JSON.stringify(state.projects[id]) !== JSON.stringify(connection)) throw new Error('embedded and external project records conflict; no files changed');
    state.projects[id] = connection;
  }
  const cleanConfig = { ...config, variables: { ...config.variables } };
  delete cleanConfig.variables.CCB_PROJECT_CONNECTIONS; delete cleanConfig.variables.CCP_PROJECT_CONNECTIONS;
  assertConnectionConfig(cleanConfig, state);
  const quarantined = [...(legacy?.quarantined || [])];
  const reports = [];
  const ports = new Map();
  const removals = new Set();
  const loaders = config.load_variables_from || [];
  if (loaders.length > 512 || config.manual_call_templates.length > 512) throw new Error('migration is bounded to 512 loaders/manuals');
  for (let index = 0; index < loaders.length; index += 1) {
    let port;
    try { port = legacyPort(loaders[index]); } catch { reports.push({ kind: 'loader', index, action: 'preserve', reason: 'unreadable-or-unsafe-identity' }); continue; }
    if (port === null) continue;
    if (!ports.has(port)) ports.set(port, await endpointState(port));
    const status = ports.get(port);
    const reference = path.resolve(loaders[index].env_file_path);
    if (status !== 'offline') { reports.push({ kind: 'loader', index, port, action: 'preserve', reason: `${status}-project-identity-unknown` }); continue; }
    removals.add(index);
    if (!quarantined.some((item) => item.kind === 'loader' && item.reference === reference)) quarantined.push({ kind: 'loader', reference, reason: 'offline-legacy-project-identity-unknown', status: 'unresolved' });
    reports.push({ kind: 'loader', index, port, action: 'quarantine', reason: 'offline-project-identity-unknown' });
  }
  const removedManuals = new Set();
  for (let index = 0; index < config.manual_call_templates.length; index += 1) {
    const manual = config.manual_call_templates[index];
    // ccb3x is an intentional historical migration input, never an active alias.
    if (!/^(?:ccb3x(?:_\d+)?|ccp3x_\d+)$/.test(String(manual.name))) continue;
    let url;
    try { url = new URL(manual.url); } catch { continue; }
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/utcp') continue;
    const port = Number(url.port);
    if (Object.values(state.projects).some((entry) => entry.port === port)) continue;
    if (!ports.has(port)) ports.set(port, await endpointState(port));
    if (ports.get(port) !== 'offline') { reports.push({ kind: 'manual', name: manual.name, port, action: 'preserve', reason: 'occupied-or-unknown-project-identity' }); continue; }
    removedManuals.add(index);
    const reference = `${manual.name} ${url.href}`;
    if (!quarantined.some((item) => item.kind === 'manual' && item.reference === reference)) quarantined.push({ kind: 'manual', reference, reason: 'offline-legacy-project-identity-unknown', status: 'unresolved' });
    reports.push({ kind: 'manual', name: manual.name, port, action: 'quarantine', reason: 'offline-project-identity-unknown' });
  }
  const changed = embedded !== undefined || removals.size > 0 || removedManuals.size > 0;
  const nextConfig = { ...cleanConfig,
    load_variables_from: loaders.filter((_, index) => !removals.has(index)),
    manual_call_templates: config.manual_call_templates.filter((_, index) => !removedManuals.has(index)),
  };
  assertConnectionConfig(nextConfig, state);
  let backup = null;
  let reportPath = null;
  if (apply && changed) withConfigLock(configPath, () => {
    if (JSON.stringify(readUtcpConfig(configPath)) !== snapshot || JSON.stringify(readConnectionState(configPath)) !== registrySnapshot) throw new Error('config or registry changed during migration; run dry-run again');
    backup = `${configPath}.backup-${Date.now()}-${randomBytes(4).toString('hex')}`;
    fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL);
    // Durable registry/report first. A partial failure leaves the old inline
    // metadata intact, so runtime selection fails closed until migration retry.
    storeConnectionState(configPath, state);
    const reportDirectory = migrationReportsPath(configPath);
    if (fs.existsSync(reportDirectory) && fs.lstatSync(reportDirectory).isSymbolicLink()) throw new Error('refusing symbolic migration report directory');
    fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
    reportPath = path.join(reportDirectory, `migration-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
    writeJsonAtomic(reportPath, { version: 1, configPath: path.resolve(configPath), backup, quarantined, registrations: reports, projectAssignmentsInferred: 0, credentialFilesDeleted: 0 });
    writeUtcpConfig(configPath, nextConfig);
  });
  return { mode: apply ? 'apply' : 'dry-run', changed, backup, registryPath: connectionRegistryPath(configPath), reportPath, credentialFilesDeleted: 0, projectAssignmentsInferred: 0, registrations: reports, quarantinedCount: quarantined.length };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply && args.includes('--dry-run')) throw new Error('choose --dry-run or --apply');
  const index = args.indexOf('--config');
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--config') { if (!args[++i]) throw new Error('--config requires a path'); }
    else if (!['--apply', '--dry-run'].includes(args[i])) throw new Error(`unknown argument ${args[i]}`);
  }
  const configPath = path.resolve(index >= 0 ? args[index + 1] : process.env.UTCP_CONFIG_FILE || path.join(os.homedir(), '.utcp_config.json'));
  migrate(configPath, apply).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { migrate };
