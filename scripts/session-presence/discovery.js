'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { requestHandshake } = require('../ccp-watchdog');
const { parseArgs } = require('./heartbeat');
const PER_PORT_NAMESPACE = /^ccp3x_([1-9]\d{0,4})$/;
const INSTANCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

class SessionLifecycleError extends Error {
  constructor(code, message) { super(message); this.name = 'SessionLifecycleError'; this.code = code; }
}
function normalizedProject(value) {
  const result = path.normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
function parseEndpoint(template) {
  if (!template || typeof template.name !== 'string' || typeof template.url !== 'string') return null;
  const match = PER_PORT_NAMESPACE.exec(template.name);
  if (!match) return null;
  try {
    const url = new URL(template.url);
    const port = Number(url.port || 80);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/utcp\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash
      || port > 65535 || port !== Number(match[1])) return null;
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return { namespace: template.name, url: url.origin, identity: `${url.hostname}:${port}` };
  } catch { return null; }
}
function readEndpoints(registryPath, namespace) {
  let registry;
  try {
    const fd = fs.openSync(registryPath, 'r');
    try {
      const data = Buffer.alloc(1048577);
      const count = fs.readSync(fd, data, 0, data.length, 0);
      if (count > 1048576) throw new Error('oversized');
      registry = JSON.parse(data.subarray(0, count).toString('utf8'));
    } finally { fs.closeSync(fd); }
  } catch { throw new SessionLifecycleError('REGISTRY_UNAVAILABLE', 'Cannot read bounded CCP registry.'); }
  if (!Array.isArray(registry?.manual_call_templates)) throw new SessionLifecycleError('REGISTRY_UNAVAILABLE', 'Invalid registry.');
  const byNamespace = new Map();
  for (const template of registry.manual_call_templates) {
    if (typeof template?.name !== 'string' || !PER_PORT_NAMESPACE.test(template.name) || (namespace && template.name !== namespace)) continue;
    const endpoint = parseEndpoint(template);
    if (!endpoint) throw new SessionLifecycleError('BINDING_INVALID', 'Invalid CCP namespace endpoint.');
    const owner = registry.variables?.[`CCP3X_OWNER_${Number(new URL(endpoint.url).port || 80)}`];
    if (owner !== undefined && (typeof owner !== 'string' || !INSTANCE_ID.test(owner))) throw new SessionLifecycleError('BINDING_INVALID', 'Invalid registry owner.');
    endpoint.owner = owner;
    const existing = byNamespace.get(endpoint.namespace);
    if (existing && existing.identity !== endpoint.identity) throw new SessionLifecycleError('BINDING_AMBIGUOUS', 'Conflicting namespace endpoints.');
    byNamespace.set(endpoint.namespace, endpoint);
  }
  const endpoints = [...byNamespace.values()];
  if (endpoints.length > 16) throw new SessionLifecycleError('BINDING_AMBIGUOUS', 'Too many endpoints; select an explicit namespace.');
  if (!endpoints.length) throw new SessionLifecycleError('BINDING_UNAVAILABLE', 'No valid per-port CCP endpoint.');
  return endpoints;
}
function validateBinding(binding, project) {
  if (!binding || typeof binding !== 'object' || typeof binding.url !== 'string' || typeof binding.instance !== 'string'
    || typeof project !== 'string' || !path.isAbsolute(project) || typeof binding.project !== 'string'
    || normalizedProject(binding.project) !== normalizedProject(project)) throw new SessionLifecycleError('BINDING_INVALID', 'Binding project mismatch.');
  let parsed;
  try { parsed = parseArgs(['--url', binding.url, '--project', project, '--instance', binding.instance, '--session', 'validation']); }
  catch { throw new SessionLifecycleError('BINDING_INVALID', 'Invalid loopback binding.'); }
  const namespace = `ccp3x_${Number(new URL(parsed.url).port || 80)}`;
  if (binding.namespace !== undefined && binding.namespace !== namespace) throw new SessionLifecycleError('BINDING_INVALID', 'Namespace port mismatch.');
  return { url: parsed.url, instance: parsed.instance, project, namespace };
}
async function discoverBinding(options) {
  if (typeof options.project !== 'string' || !path.isAbsolute(options.project)) throw new SessionLifecycleError('INVALID_PROJECT', 'Absolute project required.');
  if (options.namespace && !PER_PORT_NAMESPACE.test(options.namespace)) throw new SessionLifecycleError('INVALID_NAMESPACE', 'Per-port namespace required.');
  const endpoints = readEndpoints(options.registryPath, options.namespace);
  const matches = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, endpoints.length) }, async () => {
    while (next < endpoints.length && !options.signal?.aborted) {
      const endpoint = endpoints[next++];
      try {
        const body = await (options.requestHandshake || requestHandshake)({url: endpoint.url, project: options.project, timeoutMs: 2000}, options.signal);
        if (body && typeof body.instanceId === 'string' && INSTANCE_ID.test(body.instanceId)
          && (endpoint.owner === undefined || endpoint.owner === body.instanceId)
          && typeof body.projectPath === 'string' && path.isAbsolute(body.projectPath)
          && normalizedProject(body.projectPath) === normalizedProject(options.project) && body.projectMatches === true) {
          matches.push(validateBinding({ ...endpoint, project: options.project, instance: body.instanceId }, options.project));
        }
      } catch { /* An unavailable endpoint cannot supply a binding. */ }
    }
  }));
  if (options.signal?.aborted) throw new SessionLifecycleError('ABORTED', 'Discovery aborted.');
  if (matches.length > 1) throw new SessionLifecycleError('BINDING_AMBIGUOUS', 'Multiple editors match project; select a namespace.');
  if (!matches.length) throw new SessionLifecycleError('BINDING_UNAVAILABLE', 'No endpoint matches project and registry owner.');
  return matches[0];
}
module.exports = { SessionLifecycleError, discoverBinding, normalizedProject, parseEndpoint, readEndpoints, validateBinding };
