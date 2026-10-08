#!/usr/bin/env node
"use strict";

const { selectConnection, verifyConnection, gatewayHealthUrl } = require('./project-connection');
const connection = selectConnection();
const utcp = connection.url;
const gateway = gatewayHealthUrl(connection);

async function get(url) {
  try {
    const response = await fetch(url);
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: String((error && error.cause && error.cause.code) || error.message) };
  }
}

(async () => {
  await verifyConnection(connection);
  const [manual, health] = await Promise.all([get(utcp), get(gateway)]);
  let tools = [];
  try { tools = JSON.parse(manual.body).tools || []; } catch { /* not a manual */ }
  const hasExec = tools.some((tool) => tool.name === "executeJavascript");
  const report = {
    utcp: { url: utcp, ok: manual.ok, status: manual.status, toolCount: tools.length, executeJavascript: hasExec },
    gateway: { url: gateway, ok: health.ok, status: health.status, body: health.body.slice(0, 200) },
    ready: Boolean(manual.ok && !hasExec && health.ok),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ready ? 0 : 1);
})();
