import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = path.join(os.homedir(), '.ccp', 'local-qualification');
const issuer = 'ccp-local-qualification';
mkdirSync(root, { recursive: true, mode: 0o700 });
// Windows mode bits do not protect secrets: restrict the directory before writing.
if (process.platform === 'win32') {
  const account = execFileSync('whoami', [], { encoding: 'utf8' }).trim();
  execFileSync('icacls', [root, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe' });
}
function key(name) {
  const file = path.join(root, `${name}-private.pem`);
  if (!existsSync(file)) {
    writeFileSync(file, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  }
  const privateKey = createPrivateKey(readFileSync(file));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`${name} must be Ed25519`);
  const publicKey = createPublicKey(privateKey);
  writeFileSync(path.join(root, `${name}-public.pem`), publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 });
  return { privateKey, publicKey };
}
const memberKey = key('member-jwt');
const executionKey = key('execution');
const now = Math.floor(Date.now() / 1000);
function token(subject, role) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const claims = { iss: issuer, sub: subject, iat: now, exp: now + 86400, jti: randomUUID(), label: 'local qualification only', role, products: ['ccp'] };
  const body = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${body}.${sign(null, Buffer.from(body), memberKey.privateKey).toString('base64url')}`;
}
writeFileSync(path.join(root, 'member.jwt'), `${token('local-member', 'searcher')}\n`, { mode: 0o600 });
writeFileSync(path.join(root, 'admin.jwt'), `${token('local-admin', 'admin')}\n`, { mode: 0o600 });
const gatewayEnv = {
  CCP_GATEWAY_HOST: '127.0.0.1', CCP_GATEWAY_PORT: '18787',
  CCP_DB_PATH: path.join(root, 'ccp.db').replaceAll('\\', '/'),
  DTX_MEMBER_JWT_ISSUER: issuer,
  DTX_MEMBER_JWT_PUBLIC_KEY_PATH: path.join(root, 'member-jwt-public.pem').replaceAll('\\', '/'),
  CCP_ALLOW_MEMORY_SIGNER: '1', CCP_EXECUTION_KEY_ID: 'local-qualification-execution',
  CCP_EXECUTION_PRIVATE_KEY_PKCS8: executionKey.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
};
writeFileSync(path.join(root, 'gateway.env'), Object.entries(gatewayEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
console.log(JSON.stringify({ scope: 'local-qualification-only', issuer, expiresAt: new Date((now + 86400) * 1000).toISOString(), directory: root, gatewayOrigin: 'http://127.0.0.1:18787', memberCredentialFile: path.join(root, 'member.jwt'), adminCredentialFile: path.join(root, 'admin.jwt') }, null, 2));
