#!/usr/bin/env node
'use strict';
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs: parseWatchdogArgs, requestHandshake } = require('../ccp-watchdog');

function parseArgs(argv) {
  const args = {};
  const names = new Set(['url', 'project', 'instance', 'session', 'label', 'interval-ms', 'once']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!names.has(name) || Object.hasOwn(args, name)) throw new Error('Unknown or duplicate argument: ' + argv[i]);
    args[name] = name === 'once' ? true : argv[++i];
    if (args[name] === undefined || (typeof args[name] === 'string' && args[name].startsWith('--'))) throw new Error('Missing value: --' + name);
  }
  if (!args.url || !args.project || !args.instance || !args.session) {
    throw new Error('Required: --url <loopback HTTP base or /utcp> --project <absolute path> --instance <verified ID> --session <unique ID>');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(args.session)) throw new Error('Session must be a unique ID of at most 128 characters');
  const label = args.label ?? 'HTTP helper';
  if (typeof label !== 'string' || !label.trim() || label.trim() !== label || label.length > 256 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('Label must be 1-256 printable characters without surrounding whitespace');
  const common = ['--url', args.url, '--project', args.project, '--instance', args.instance];
  if (args['interval-ms'] !== undefined) common.push('--interval-ms', args['interval-ms']);
  const binding = parseWatchdogArgs(common);
  // Leave room for handshake + beat deadlines inside the 15-second Active TTL.
  if (binding.intervalMs > 10000) throw new Error('Session heartbeat interval must be 1000–10000ms.');
  return { ...binding, session: args.session, label, once: args.once === true };
}

function normalizedProject(value) {
  const result = path.normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function validateIdentity(body, options) {
  if (!body || typeof body.instanceId !== 'string' || typeof body.projectPath !== 'string') throw new Error('INVALID_HANDSHAKE');
  if (body.instanceId !== options.instance || !path.isAbsolute(body.projectPath)
      || normalizedProject(body.projectPath) !== normalizedProject(options.project) || body.projectMatches !== true) {
    throw new Error('IDENTITY_MISMATCH_REBIND_REQUIRED');
  }
}

function requestHeartbeat(options, operation, signal) {
  const payload = JSON.stringify({ sessionId: options.session, label: options.label,
    expectedInstanceId: options.instance, transport: 'http-helper', operation });
  return new Promise((resolve, reject) => {
    let request, timer, finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { request?.destroy(); reject(error); } else resolve(result);
    };
    const abort = () => finish(new Error('ABORTED'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    // Absolute deadline and byte cap apply even when the server keeps trickling data.
    timer = setTimeout(() => finish(new Error('HTTP_DEADLINE')), 2000);
    request = http.request(new URL('/tools/editorSessionHeartbeat', options.url), {
      method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, response => {
      if (response.statusCode !== 200) return finish(new Error('HTTP_STATUS_' + response.statusCode));
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) return finish(new Error('HTTP_RESPONSE_TOO_LARGE'));
        if (!finished) chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new Error('HTTP_RESPONSE_ABORTED')));
      response.on('end', () => {
        if (finished) return;
        try {
          let body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body && Object.hasOwn(body, 'ok')) {
            if (body.ok !== true || body.tool !== 'editorSessionHeartbeat') throw new Error('INVALID_ENVELOPE');
            body = body.data;
          }
          if (!body || typeof body !== 'object' || Array.isArray(body) || body.sessionId !== options.session
              || body.transport !== 'http-helper' || body.label !== options.label || !Number.isFinite(body.lastSeen)
              || body.lastSeen < 0 || !Number.isFinite(body.ageMs) || body.ageMs < 0
              || body.status !== (operation === 'close' ? 'Expired' : 'Active')) throw new Error('INVALID_HEARTBEAT');
          finish(null, body);
        } catch (error) { finish(error); }
      });
    });
    request.on('error', error => finish(error));
    request.end(payload);
  });
}

async function run(input, signal, emit = status => process.stdout.write(JSON.stringify(status) + '\n')) {
  // Programmatic callers cannot bypass CLI binding validation or the fixed deadline.
  const argv = ['--url', input.url, '--project', input.project, '--instance', input.instance, '--session', input.session];
  if (input.label !== undefined) argv.push('--label', input.label);
  if (input.intervalMs !== undefined) argv.push('--interval-ms', String(input.intervalMs));
  if (input.once) argv.push('--once');
  const options = parseArgs(argv);
  let state, errors = 0, attemptedBeat = false, identityFailed = false;
  const transition = (next, reason) => {
    if (next === state) return;
    state = next;
    emit({ state, reason, checkedAt: Date.now(), sessionId: options.session, label: options.label,
      transport: 'http-helper', instanceId: options.instance, projectPath: options.project });
  };
  let nextCycle = performance.now();
  try {
    while (!signal?.aborted) {
      try {
        validateIdentity(await requestHandshake(options, signal), options);
        if (signal?.aborted) break;
        attemptedBeat = true;
        await requestHeartbeat(options, 'beat', signal);
        if (signal?.aborted) break;
        errors = 0;
        transition('Active', 'HTTP_HELPER_HEARTBEAT_ACCEPTED');
      } catch (error) {
        if (signal?.aborted) break;
        identityFailed = error.message === 'IDENTITY_MISMATCH_REBIND_REQUIRED' || error.message === 'HTTP_STATUS_409';
        transition('Error', error.message);
        if (identityFailed || options.once || ++errors >= 3) throw error;
      }
      if (options.once) return;
      // Skip missed slots rather than issuing catch-up bursts; at most one cycle is in flight.
      nextCycle += options.intervalMs;
      if (nextCycle <= performance.now()) nextCycle += (Math.floor((performance.now() - nextCycle) / options.intervalMs) + 1) * options.intervalMs;
      try { await delay(Math.max(1, nextCycle - performance.now()), undefined, { signal }); }
      catch (error) { if (!signal?.aborted) throw error; }
    }
  } finally {
    // --once deliberately leaves one observation to age; a supervised daemon closes on stop.
    if ((!options.once || signal?.aborted) && attemptedBeat && !identityFailed && signal?.reason !== 'IDENTITY_MISMATCH_REBIND_REQUIRED') {
      try {
        await requestHeartbeat(options, 'close');
        transition('Stopped', 'HTTP_HELPER_CLOSED');
      } catch (error) { transition('Stopped', 'CLOSE_UNCONFIRMED_' + error.message); }
    } else if (!options.once || signal?.aborted) transition('Stopped', identityFailed ? 'IDENTITY_MISMATCH_REBIND_REQUIRED' : 'HTTP_HELPER_STOPPED');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try { await run(options, controller.signal); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

module.exports = { parseArgs, requestHeartbeat, run };
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
