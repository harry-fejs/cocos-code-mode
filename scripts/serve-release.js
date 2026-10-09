#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const HOST = process.env.CCP_RELEASE_HOST || '192.168.20.100';
const PORT = Number(process.env.CCP_RELEASE_PORT || '8788');
const ROOT = path.resolve(process.env.CCP_RELEASE_DIRECTORY || path.join(__dirname, '..', 'release-set'));
const CERT = process.env.CCP_RELEASE_TLS_CERT;
const KEY = process.env.CCP_RELEASE_TLS_KEY;

const ALLOWED = new Map([
  ['/metadata/root.json', 'metadata/root.json'],
  ['/metadata/target.json', 'metadata/target.json'],
  ['/metadata/policy.json', 'metadata/policy.json'],
  ['/release.zip', 'release.zip'],
  ['/package-manifest.json', 'package-manifest.json'],
  ['/sbom.cdx.json', 'sbom.cdx.json'],
  ['/provenance.intoto.json', 'provenance.intoto.json'],
]);

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

function validate() {
  if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('CCP_RELEASE_PORT must be 1..65535');
  if (!HOST || /[/?#]/.test(HOST)) throw new Error('CCP_RELEASE_HOST must be a plain bind address');
  const cert = required('CCP_RELEASE_TLS_CERT', CERT);
  const key = required('CCP_RELEASE_TLS_KEY', KEY);
  if (!fs.statSync(cert).isFile() || !fs.statSync(key).isFile()) throw new Error('TLS certificate and key must be regular files');
  if (!fs.statSync(ROOT).isDirectory()) throw new Error(`release directory does not exist: ${ROOT}`);
  for (const relative of ALLOWED.values()) {
    const target = path.resolve(ROOT, relative);
    const prefix = `${ROOT}${path.sep}`;
    if (!target.startsWith(prefix) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`release artifact missing: ${relative}`);
    }
  }
  return { cert, key };
}

function sendFile(res, relative) {
  const target = path.resolve(ROOT, relative);
  const prefix = `${ROOT}${path.sep}`;
  if (!target.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
  let stat;
  try { stat = fs.statSync(target); } catch { res.writeHead(404); res.end(); return; }
  if (!stat.isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    'content-length': stat.size,
    'content-type': relative.endsWith('.zip') ? 'application/zip' : 'application/json; charset=utf-8',
    'content-encoding': 'identity',
    'cache-control': 'no-store',
  });
  fs.createReadStream(target).on('error', () => { if (!res.headersSent) res.writeHead(500); res.destroy(); }).pipe(res);
}

function main() {
  const tls = validate();
  const server = https.createServer({ key: fs.readFileSync(tls.key), cert: fs.readFileSync(tls.cert) }, (req, res) => {
    if (req.method !== 'GET' || !ALLOWED.has(req.url)) { res.writeHead(404); res.end(); return; }
    sendFile(res, ALLOWED.get(req.url));
  });
  server.listen(PORT, HOST, () => console.log(`CCP release HTTPS origin: https://${HOST}:${PORT}/ root=${ROOT}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

try { main(); } catch (error) { console.error(`serve-release failed: ${error.message}`); process.exitCode = 1; }
