const fs = require('fs');
const path = require('path');

let base = null; // resolved once

function discoverBase() {
  if (base) return base;
  const { selectConnection } = require('../../scripts/project-connection');
  const connection = selectConnection();
  base = connection.base;
  return base;
}

async function getJson(urlPath, init) {
  const b = discoverBase();
  const { selectConnection, connectionHeaders, verifyConnection } = require('../../scripts/project-connection');
  const connection = selectConnection({ url: b });
  await verifyConnection(connection);
  if (urlPath !== '/utcp' && urlPath !== '/build-info') init = { ...init, headers: { ...connectionHeaders(connection), ...(init && init.headers) } };
  const url = b + urlPath;
  const r = await fetch(url, init);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: r.ok, status: r.status, body, text, base: b };
}

async function postTool(toolPath, body) {
  return getJson(`/tools/${toolPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

function resVal(body) {
  if (body == null) return null;
  if (typeof body === 'object' && 'result' in body) return body.result;
  return null;
}

module.exports = { discoverBase, getJson, postTool, healthCheck, resVal };
