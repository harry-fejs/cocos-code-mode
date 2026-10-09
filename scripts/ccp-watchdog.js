#!/usr/bin/env node
'use strict';
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

function parseArgs(argv) {
  const args = {};
  const names = new Set(['url', 'project', 'instance', 'interval-ms', 'timeout-ms', 'once']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!names.has(name) || Object.hasOwn(args, name)) throw new Error('Unknown or duplicate argument: ' + argv[i]);
    args[name] = name === 'once' ? true : argv[++i];
    if (args[name] === undefined || (typeof args[name] === 'string' && args[name].startsWith('--'))) throw new Error('Missing value: --' + name);
  }
  if (!args.url || !args.project || !args.instance) throw new Error('Required: --url <loopback http base or /utcp> --project <absolute path> --instance <verified ID>');
  const url = new URL(args.url);
  if (url.protocol !== 'http:' || !/^(127(?:\.\d{1,3}){3}|localhost)$/.test(url.hostname)
      || !['/', '/utcp', '/utcp/'].includes(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('URL must be an IPv4 loopback HTTP base or /utcp endpoint without credentials, query or fragment');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'; // Avoid DNS/rebinding.
  if (!path.isAbsolute(args.project) || args.project.length > 4096 || /[\x00-\x1f]/.test(args.project)) throw new Error('Project must be an absolute path');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(args.instance)) throw new Error('Instance must be an explicit verified ID');
  function number(name, fallback, min, max) {
    const value = args[name] === undefined ? String(fallback) : args[name];
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error('Invalid --' + name);
    return Number(value);
  }
  return { url: url.origin, project: args.project, instance: args.instance, once: args.once === true,
    intervalMs: number('interval-ms', 5000, 1000, 2147483647), timeoutMs: number('timeout-ms', 2000, 100, 10000) };
}

function requestHandshake(options, signal) {
  const url = new URL('/tools/editorHandshake', options.url);
  url.searchParams.set('expectedProjectPath', options.project);
  url.searchParams.set('timeoutMs', String(Math.min(1000, Math.max(1, options.timeoutMs - 50))));
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
    // Absolute deadline, not socket inactivity: trickling bytes cannot extend it.
    timer = setTimeout(() => finish(new Error('HTTP_DEADLINE')), options.timeoutMs);
    request = http.get(url, { agent: false }, response => {
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
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body && Object.hasOwn(body, 'ok')) {
            if (body.ok !== true || body.tool !== 'editorHandshake') throw new Error('INVALID_ENVELOPE');
            finish(null, body.data);
          } else finish(null, body);
        } catch (error) { finish(error); }
      });
    });
    request.on('error', error => finish(error));
  });
}

function normalizedProject(value) {
  const result = path.normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

class Watchdog {
  constructor(options) {
    // Importers receive the same fail-closed validation as CLI callers.
    this.options = parseArgs(['--url', options.url, '--project', options.project, '--instance', options.instance,
      '--interval-ms', String(options.intervalMs ?? 5000), '--timeout-ms', String(options.timeoutMs ?? 2000)]);
    this.state = 'Healthy';
    this.transportFailures = 0;
    this.failedRequests = new Set();
    this.goodResponses = 0;
    this.requiresReadback = false;
    this.identityFailed = false;
    this.inFlight = false;
  }

  observe(body, latencyMs, error = null, checkedAt = Date.now()) {
    let reason = 'responsive', severe = false, good = false;
    const probe = body?.probe, evidence = probe?.evidence;
    if (error) {
      reason = error.message || 'HTTP_ERROR';
      severe = ++this.transportFailures >= 3;
    } else {
      this.transportFailures = 0;
      if (!body || typeof body !== 'object' || typeof body.instanceId !== 'string' || typeof body.projectPath !== 'string') reason = 'INVALID_HANDSHAKE';
      else if (body.instanceId !== this.options.instance || !path.isAbsolute(body.projectPath)
          || normalizedProject(body.projectPath) !== normalizedProject(this.options.project) || body.projectMatches !== true) {
        this.identityFailed = true;
        reason = 'IDENTITY_MISMATCH_REBIND_REQUIRED';
      } else if (!probe || !['responsive', 'timeout', 'error', 'invalid-response'].includes(probe.status)
          || !evidence || typeof evidence.requestId !== 'string' || !evidence.requestId
          || !Number.isFinite(evidence.startedAt) || evidence.startedAt < 0 || !Number.isFinite(evidence.ageMs) || evidence.ageMs < 0
          || typeof evidence.shared !== 'boolean' || typeof evidence.settled !== 'boolean'
          || ![true, false, null].includes(probe.sceneReady)) reason = 'INVALID_PROBE';
      else if (probe.status !== 'responsive') {
        if (this.failedRequests.size < 3) this.failedRequests.add(evidence.requestId);
        severe = (!evidence.settled && evidence.ageMs >= 10000) || this.failedRequests.size >= 3;
        reason = !evidence.settled ? 'IPC_PENDING' : 'IPC_' + probe.status.toUpperCase();
      } else if (!evidence.settled || typeof probe.sceneReady !== 'boolean') reason = 'INVALID_PROBE';
      else if (latencyMs > 1000) reason = 'SLOW_RESPONSE';
      else { good = true; reason = probe.sceneReady ? 'responsive' : 'SCENE_NOT_READY'; }
    }
    if (this.identityFailed) { good = false; reason = 'IDENTITY_MISMATCH_REBIND_REQUIRED'; }
    if (good) {
      this.failedRequests.clear();
      this.goodResponses++;
      this.state = this.state === 'Healthy' || this.goodResponses >= 2 ? 'Healthy' : 'Recovering';
    } else {
      this.goodResponses = 0;
      this.requiresReadback = true;
      this.state = severe || this.state === 'Unresponsive' ? 'Unresponsive' : 'Degraded';
    }
    // Advisory only: scene IPC is not proof of Code Mode execution. No mutations are issued.
    // After an incident, restart only AFTER caller readback + a fresh verified handshake.
    return { state: this.state, reason, checkedAt, latencyMs: Math.round(latencyMs),
      safeToMutate: this.state === 'Healthy' && probe?.sceneReady === true && !this.requiresReadback,
      requiresReadback: this.requiresReadback, instanceId: this.options.instance, projectPath: this.options.project };
  }

  async probe(signal) {
    if (this.inFlight) throw new Error('Probe already in flight');
    this.inFlight = true;
    const started = performance.now();
    try {
      const body = await requestHandshake(this.options, signal);
      return this.observe(body, performance.now() - started);
    } catch (error) {
      if (signal?.aborted) throw error;
      return this.observe(null, performance.now() - started, error);
    } finally { this.inFlight = false; }
  }
}

async function run(options, signal, emit = status => process.stdout.write(JSON.stringify(status) + '\n')) {
  const watchdog = new Watchdog(options);
  while (!signal?.aborted) {
    try {
      const status = await watchdog.probe(signal);
      if (signal?.aborted) break;
      emit(status);
      if (options.once) break;
      await delay(watchdog.options.intervalMs, undefined, { signal });
    } catch (error) { if (!signal?.aborted) throw error; }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await run(options, controller.signal); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

module.exports = { parseArgs, requestHandshake, Watchdog, run };
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
