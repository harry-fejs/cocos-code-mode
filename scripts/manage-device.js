'use strict';

const { URL } = require('node:url');
const { readCredential } = require('./credential-input');

const origin = new URL(process.env.CCP_GATEWAY_ORIGIN || 'http://127.0.0.1:8787');
const credential = readCredential('CCP_ADMIN_CREDENTIAL', 'CCP_ADMIN_CREDENTIAL_FILE');

function fail(message) { throw new Error(message); }
function validateOrigin() {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)) fail('CCP_GATEWAY_ORIGIN must be an exact origin');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback && process.env.CCP_ALLOW_INSECURE_GATEWAY === '1')) fail('Gateway must use HTTPS, except explicit loopback qualification');
}
function id(name, value) {
  if (!value || !/^[0-9a-f-]{36}$/i.test(value)) fail(`${name} must be a UUID`);
  return value;
}
function required(name, value, max = 128) {
  if (!value || value.length > max) fail(`${name} is required and bounded`);
  return value;
}
async function request(method, relative, body) {
  if (!credential) fail('CCP_ADMIN_CREDENTIAL is required');
  const response = await fetch(new URL(relative, `${origin.origin}/`), {
    method,
    redirect: 'error',
    headers: { authorization: `Bearer ${credential}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { fail(`Gateway returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) fail(`Gateway HTTP ${response.status}: ${value.code || value.error || 'request denied'}`);
  return value;
}
function grantBody() {
  const body = {
    memberId: process.env.CCP_GRANT_MEMBER_ID || undefined,
    deviceId: id('CCP_GRANT_DEVICE_ID', process.env.CCP_GRANT_DEVICE_ID),
    projectId: required('CCP_GRANT_PROJECT_ID', process.env.CCP_GRANT_PROJECT_ID),
    toolId: process.env.CCP_GRANT_TOOL_ID || undefined,
    operationClass: required('CCP_GRANT_OPERATION_CLASS', process.env.CCP_GRANT_OPERATION_CLASS, 16),
    expiresAtMs: process.env.CCP_GRANT_EXPIRES_AT_MS ? Number(process.env.CCP_GRANT_EXPIRES_AT_MS) : undefined,
  };
  if (!['read', 'mutation', 'capture', 'control'].includes(body.operationClass)) fail('CCP_GRANT_OPERATION_CLASS is invalid');
  if (body.expiresAtMs !== undefined && (!Number.isSafeInteger(body.expiresAtMs) || body.expiresAtMs <= Date.now())) fail('CCP_GRANT_EXPIRES_AT_MS must be a future safe integer');
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}
async function main() {
  validateOrigin();
  const [command, value] = process.argv.slice(2);
  let result;
  if (command === 'approve') result = await request('POST', `ccp/v1/devices/${id('deviceId', value)}/approve`);
  else if (command === 'revoke-device') result = await request('POST', `ccp/v1/devices/${id('deviceId', value)}/revoke`);
  else if (command === 'grant') result = await request('POST', 'ccp/v1/admin/grants', grantBody());
  else if (command === 'revoke-grant') result = await request('POST', `ccp/v1/admin/grants/${id('grantId', value)}/revoke`);
  else if (command === 'list-devices') result = await request('GET', 'ccp/v1/admin/devices');
  else if (command === 'list-grants') result = await request('GET', 'ccp/v1/admin/grants');
  else fail('usage: approve|revoke-device|grant|revoke-grant|list-devices|list-grants');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(`manage-device failed: ${error.message}`); process.exitCode = 1; });
module.exports = { grantBody, validateOrigin };
