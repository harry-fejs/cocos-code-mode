const fs = require('fs');
const path = require('path');

let base = null; // resolved once

function discoverBase() {
  if (base) return base;
  if (process.env.UTCP_BASE) { base = process.env.UTCP_BASE.replace(/\/$/, ''); return base; }
  const port = Number(process.env.UTCP_PORT || process.argv.find(a => /^\d{4,5}$/.test(a)) || 0);
  if (port) { base = `http://localhost:${port}`; return base; }
  try {
    const home = process.env.HOME || process.env.USERPROFILE || require('os').homedir();
    const utcpPath = process.env.UTCP_CONFIG_FILE || path.join(home, '.utcp_config.json');
    const raw = fs.readFileSync(utcpPath, 'utf8');
    const cfg = JSON.parse(raw);
    const tpls = cfg.manual_call_templates || [];
    // Select only a per-port CCP 3x endpoint; multiple editors require an explicit target.
    const candidates = tpls.filter(t => /^ccp3x_\d+$/.test(t.name));
    if (candidates.length !== 1) throw new Error('Select UTCP_BASE or UTCP_PORT for the intended CCP 3x editor.');
    const endpoint = new URL(candidates[0].url);
    const endpointPort = Number(endpoint.port || 80);
    if (endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)
      && candidates[0].name === `ccp3x_${endpointPort}`) { base = endpoint.origin; return base; }
  } catch {}
  throw new Error('Cannot discover UTCP port: is ccp3x running? Set UTCP_BASE or pass --utcp-port=49650.');
}
async function emitCreatorTrace(baseUrl, level, message, data) {
  try {
    const response = await fetch(baseUrl + '/tools/editorLog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level, message, data }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`status=${response.status}`);
  } catch {
    // Preserve the diagnostic locally without changing the tool's outcome.
    console.warn(`[LT] TRACE_UNAVAILABLE | ${message}`);
  }
}


function formatTraceParams(urlPath, init) {
  const values = Object.create(null);
  const query = urlPath.split('?')[1];
  if (query) for (const [key, value] of new URLSearchParams(query)) values[key] = value;
  if (init?.body !== undefined) {
    try {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      if (body && typeof body === 'object' && !Array.isArray(body)) Object.assign(values, body);
    } catch {}
  }
  return summarizeTraceResult(values);
}

function summarizeTraceResult(body) {
  const seen = new WeakSet();
  let count = 0;
  let truncated = false;
  const serialized = JSON.stringify(body, (key, value) => {
    if (/password|secret|token|authorization|cookie|api.?key|credential/i.test(key)) return '[REDACTED]';
    if (++count > 100) { truncated = true; return '[truncated]'; }
    if (typeof value === 'string' && value.length > 180) {
      truncated = true;
      return value.slice(0, 180) + '[truncated]';
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  }) ?? 'undefined';
  const text = serialized.length > 1600 ? serialized.slice(0, 1600) : serialized;
  return text + (truncated || serialized.length > 1600 ? ' [truncated]' : '');
}

async function getJson(urlPath, init) {
  const b = discoverBase();
  const url = b + urlPath;
  const functionName = urlPath.split('?')[0].replace(/^\/tools\//, '').replace(/^\//, '');
  const traceParams = formatTraceParams(urlPath, init);
  const trace = process.env.UTCP_TEST_TRACE !== '0';
  const traceId = require('crypto').randomBytes(4).toString('hex').slice(0, 5);
  if (trace && urlPath !== '/tools/editorLog') {
    await emitCreatorTrace(b, 'info', `[LT][${traceId}] ${functionName} REQ | params=${traceParams}`);
  }
  const startedAt = performance.now();
  let r;
  let text;
  try {
    r = await fetch(url, { ...init, signal: init?.signal || AbortSignal.timeout(Math.min(120000, Math.max(1000, Number(process.env.CCP_REQUEST_TIMEOUT_MS || 30000) || 30000))) });
    text = await r.text();
  } catch (error) {
    if (trace && urlPath !== '/tools/editorLog') {
      // Do not print fetch messages: they can contain transport URLs/credentials.
      const kind = init?.signal?.aborted ? 'ABORTED' : r ? 'RESPONSE_READ_FAILED' : 'CONNECTION_FAILED';
      const message = `[LT][${traceId}] ${functionName} ${kind} | elapsed=${(performance.now() - startedAt).toFixed(1)}ms | params=${traceParams}`;
      await emitCreatorTrace(b, 'error', message);
    }
    throw error;
  }
  const durationMs = (performance.now() - startedAt).toFixed(1);
  let body;
  let parsed = true;
  try { body = JSON.parse(text); } catch { body = text; parsed = false; }
  if (trace && urlPath !== '/tools/editorLog') {
    const serverId = r.headers.get('x-request-id');
    const serverDuration = r.headers.get('x-duration-ms');
    const correlation = serverId && /^[a-zA-Z0-9_-]{1,128}$/.test(serverId) ? ` | serverId=${serverId}` : '';
    const timing = serverDuration && /^\d+(?:\.\d+)?$/.test(serverDuration) ? ` | server=${serverDuration}ms` : '';
    await emitCreatorTrace(b, r.ok ? 'info' : 'warn', `[LT][${traceId}] ${functionName} ${r.ok ? 'OK' : 'ERR'} ${r.status}${correlation} | result=${summarizeTraceResult(body)} | elapsed=${durationMs}ms${timing} | bytes=${Buffer.byteLength(text, 'utf8')}${parsed ? '' : ' | NON_JSON'}`);
  }
  return { ok: r.ok, status: r.status, body, text, base: b };
}

async function getExpectedErrorJson(urlPath, testId, init = {}) {
  return getJson(urlPath, {
    ...init,
    headers: {
      ...init.headers,
      'x-ccp-expected-error': 'true',
      'x-ccp-test-id': testId,
    },
  });
}

async function fetchTargetUrl(url, init = {}) {
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
    throw new Error('Target URL must be a loopback HTTP URL returned by a CCP tool.');
  }
  return fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(5000) });
}

const actionDelayMs = Math.min(5000, Math.max(0, Number(process.env.CCP_ACTION_DELAY_MS || 5) || 0));

async function delayAfterAction() {
  if (actionDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, actionDelayMs));
}

async function logTestIteration(testId, iteration, total, status, reason) {
  const suffix = reason ? ` | ${String(reason).slice(0, 240)}` : '';
  try {
    const result = await getJson('/tools/editorLog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        level: status === 'FAIL' ? 'error' : status === 'PASS' ? 'info' : 'warn',
        message: `[TC ${testId}] ${iteration}/${total} ${status}${suffix}`,
        data: { testId, iteration, total, status, reason: reason ? String(reason) : undefined },
      }),
    });
    if (!result.ok) console.warn(`[TC ${testId}] ${iteration}/${total} editorLog unavailable (${result.status})`);
    return result;
  } catch (error) {
    console.warn(`[TC ${testId}] ${iteration}/${total} editorLog unavailable (${error?.message || error})`);
    return null;
  }
}
const defaultTestIterations = Math.min(100, Math.max(5, Number(process.env.CCP_TEST_ITERATIONS || 5) || 5));

async function repeatTestcase(testId, fn, total = defaultTestIterations) {
  for (let iteration = 1; iteration <= total; iteration++) {
    await logTestIteration(testId, iteration, total, 'START');
    try {
      const outcome = await fn({ iteration, total });
      if (outcome?.status === 'SKIP') {
        await logTestIteration(testId, iteration, total, 'SKIP', outcome.reason);
      } else {
        await logTestIteration(testId, iteration, total, 'PASS');
      }
    } catch (error) {
      await logTestIteration(testId, iteration, total, 'FAIL', error?.message || error);
      throw error;
    }
  }
}

async function postTool(toolPath, body) {
  const result = await getJson(`/tools/${toolPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await delayAfterAction();
  return result;
}

async function postExpectedErrorTool(toolPath, body, testId) {
  const result = await getJson(`/tools/${toolPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ccp-expected-error': 'true',
      'x-ccp-test-id': testId,
    },
    body: JSON.stringify(body),
  });
  await delayAfterAction();
  return result;
}

async function healthCheck() {
  try {
    const r = await getJson('/utcp');
    if (!r.ok) return { ok: false, reason: `GET /utcp -> ${r.status}` };
    const n = Array.isArray(r.body && r.body.tools) ? r.body.tools.length : -1;
    const hasExec = (r.body.tools || []).some(t => t.name === 'executeJavascript');
    return { ok: true, toolCount: n, hasExec, base: r.base };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function getCanvasReference() {
  const result = await getJson('/tools/findNodes?componentType=cc.Canvas&maxResults=1');
  if (!result.ok) return null;
  return result.body?.nodes?.[0]?.reference ?? null;
}

function resVal(body) {
  if (body == null) return null;
  if (typeof body === 'object' && 'result' in body) return body.result;
  return null;
}

module.exports = { discoverBase, getJson, getExpectedErrorJson, postTool, postExpectedErrorTool, logTestIteration, repeatTestcase, healthCheck, getCanvasReference, resVal, fetchTargetUrl };
