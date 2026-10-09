'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { assertConnectionConfig, readConnectionState, canonicalProjectPath } = require('../dist/utcp/project-connection');
const { withConfigLock } = require('../dist/utcp/config-store');
function selectConnection(options = {}) {
  const configPath = options.configPath || process.env.UTCP_CONFIG_FILE || path.join(os.homedir(), '.utcp_config.json');
  const stat = fs.statSync(configPath);
  if (stat.size > 4 * 1024 * 1024) throw new Error('UTCP config exceeds selection bound');
  const { config, state } = withConfigLock(configPath, () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const state = readConnectionState(configPath);
    assertConnectionConfig(config, state);
    return { config, state };
  });
  const requestedPath = options.projectPath || process.env.CCP_PROJECT_PATH;
  const explicit = options.url || process.env.CCP_UTCP_URL || process.env.UTCP_BASE || (process.env.UTCP_PORT ? `http://localhost:${process.env.UTCP_PORT}` : undefined);
  const canonical = requestedPath ? canonicalProjectPath(requestedPath) : null;
  const projectId = canonical ? createHash('sha256').update(canonical).digest('hex') : null;
  let candidates = Object.values(state.projects).filter((item) => item.active && (!projectId || item.projectId === projectId));
  if (explicit) {
    const url = new URL(explicit);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/', '/utcp'].includes(url.pathname)) throw new Error('explicit relay must be an exact loopback endpoint');
    candidates = candidates.filter((item) => item.port === Number(url.port));
  }
  if (!canonical && !explicit) throw new Error('set CCP_PROJECT_PATH (canonical Cocos project) or an explicit registered relay endpoint; no latest/first fallback');
  if (candidates.length !== 1) throw new Error('no unambiguous active binding for requested project/port');
  const connection = candidates[0];
  const templates = (config.manual_call_templates || []).filter((item) => item.name === `ccp3x_${connection.port}`);
  if (templates.length !== 1 || templates[0].url !== `http://localhost:${connection.port}/utcp`) throw new Error('project metadata and per-port manual disagree');
  return { ...connection, url: templates[0].url, base: `http://localhost:${connection.port}` };
}
function connectionHeaders(connection) {
  const stat = fs.lstatSync(connection.tokenPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('credential file is not bounded/private');
  const values = {};
  for (const line of fs.readFileSync(connection.tokenPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1 || Object.hasOwn(values, line.slice(0, separator))) throw new Error('malformed credential variables');
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const prefix = `ccp3x__${connection.port}_`;
  if (values[`${prefix}CCP_RELAY_INSTANCE_ID`] !== connection.relayInstanceId || values[`${prefix}CCP_BOUND_PORT`] !== String(connection.port) || values[`${prefix}CCP_LOCAL_PROJECT_ID`] !== connection.projectId || !/^[A-Za-z0-9_-]{43}$/.test(values[`${prefix}CCP_LOCAL_TOKEN`] || '')) throw new Error('credential file belongs to another project/port/session');
  return { 'x-ccp-local-token': values[`${prefix}CCP_LOCAL_TOKEN`], 'x-ccp-relay-instance': connection.relayInstanceId, 'x-ccp-bound-port': String(connection.port), 'x-ccp-project-id': connection.projectId };
}
async function verifyConnection(connection) {
  const response = await fetch(`${connection.base}/connection`, { headers: connectionHeaders(connection), redirect: 'error', signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('relay does not support project identity verification; refusing unverified endpoint');
  const text = await response.text();
  if (Buffer.byteLength(text) > 8192) throw new Error('connection response exceeds bound');
  const live = JSON.parse(text);
  if (live.projectPath !== connection.projectPath || live.projectId !== connection.projectId || live.port !== connection.port || live.relayInstanceId !== connection.relayInstanceId || JSON.stringify(live.gateway) !== JSON.stringify(connection.gateway)) throw new Error('live relay is bound to another project/port/session/Gateway');
}
function gatewayHealthUrl(connection) {
  if (!connection.gateway.origin) throw new Error('selected project has no configured Gateway endpoint');
  const assigned = new URL('/ccp/v1/health', connection.gateway.origin).href;
  if (process.env.CCP_GATEWAY_HEALTH && process.env.CCP_GATEWAY_HEALTH !== assigned) throw new Error('health endpoint differs from selected project Gateway assignment');
  return assigned;
}
module.exports = { selectConnection, connectionHeaders, verifyConnection, gatewayHealthUrl };
