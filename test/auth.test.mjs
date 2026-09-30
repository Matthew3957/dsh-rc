import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  hashPassphrase,
  verifyPassphrase,
  savePassphrase,
  loadPassphraseRecord,
  loadSessionSecret,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  createRateLimiter,
  createAuth,
  passphraseProblem,
  MIN_PASSPHRASE_LENGTH,
} from '../server/auth.mjs';
import { readBody } from '../server/index.mjs';

async function tmpDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rc-auth-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('hashPassphrase / verifyPassphrase round-trip, and rejects the wrong phrase', () => {
  const record = hashPassphrase('correct horse battery staple');
  assert.equal(verifyPassphrase('correct horse battery staple', record), true);
  assert.equal(verifyPassphrase('wrong', record), false);
});

test('savePassphrase writes a 0600 file, loadPassphraseRecord reads it back', async (t) => {
  const stateDir = await tmpDir(t);
  savePassphrase(stateDir, 'hunter2-but-longer');
  const file = path.join(stateDir, 'passphrase.json');
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  const record = loadPassphraseRecord(stateDir, {});
  assert.equal(verifyPassphrase('hunter2-but-longer', record), true);
});

test('loadPassphraseRecord falls back to DSH_RC_PASSPHRASE when no file exists', async (t) => {
  const stateDir = await tmpDir(t);
  const record = loadPassphraseRecord(stateDir, { DSH_RC_PASSPHRASE: 'from-env-passphrase' });
  assert.equal(verifyPassphrase('from-env-passphrase', record), true);
  assert.equal(loadPassphraseRecord(stateDir, {}), null);
});

test('the state-dir file takes precedence over DSH_RC_PASSPHRASE', async (t) => {
  const stateDir = await tmpDir(t);
  savePassphrase(stateDir, 'file-wins-passphrase');
  const record = loadPassphraseRecord(stateDir, { DSH_RC_PASSPHRASE: 'env-loses-passphrase' });
  assert.equal(verifyPassphrase('file-wins-passphrase', record), true);
  assert.equal(verifyPassphrase('env-loses-passphrase', record), false);
});

test('loadSessionSecret persists a 0600 secret across calls', async (t) => {
  const stateDir = await tmpDir(t);
  const a = loadSessionSecret(stateDir);
  const b = loadSessionSecret(stateDir);
  assert.deepEqual(a, b);
  assert.equal((await fsp.stat(path.join(stateDir, 'session-secret'))).mode & 0o777, 0o600);
});

test('session tokens verify with the right secret and expire on time', () => {
  const secret = Buffer.from('a'.repeat(64), 'hex');
  let now = 1_000_000;
  const token = createSessionToken(secret, { ttlMs: 1000, now });
  assert.equal(verifySessionToken(secret, token, { now }), true);
  assert.equal(verifySessionToken(secret, token, { now: now + 1001 }), false);
});

test('session tokens are rejected under a different secret or when tampered', () => {
  const secretA = Buffer.alloc(32, 1);
  const secretB = Buffer.alloc(32, 2);
  const token = createSessionToken(secretA);
  assert.equal(verifySessionToken(secretB, token), false);
  const [payload] = token.split('.');
  const tampered = `${Number(payload) + 100000}.${token.split('.')[1]}`;
  assert.equal(verifySessionToken(secretA, tampered), false);
  assert.equal(verifySessionToken(secretA, 'garbage'), false);
  assert.equal(verifySessionToken(secretA, null), false);
});

test('cookie helpers round-trip and set the right attributes', () => {
  const cookies = parseCookies('dsh_rc_session=abc.def; other=1');
  assert.equal(cookies.dsh_rc_session, 'abc.def');
  const set = sessionCookieHeader('tok', { secure: true });
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Secure/);
  const insecure = sessionCookieHeader('tok', { secure: false });
  assert.doesNotMatch(insecure, /Secure/);
  assert.match(clearCookieHeader({ secure: true }), /Max-Age=0/);
});

test('rate limiter allows up to max attempts per window, then blocks', () => {
  let now = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: () => now });
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
  now = 2000;
  assert.equal(limiter.allow(), true, 'a new window resets the count');
});

test('passphrases shorter than the minimum are refused', async (t) => {
  const stateDir = await tmpDir(t);
  assert.ok(passphraseProblem('short'));
  assert.equal(passphraseProblem('x'.repeat(MIN_PASSPHRASE_LENGTH)), null);
  assert.throws(() => savePassphrase(stateDir, 'short'), /at least/);
  assert.throws(() => loadPassphraseRecord(stateDir, { DSH_RC_PASSPHRASE: 'short' }), /DSH_RC_PASSPHRASE/);
});

test('saving a new passphrase replaces the session secret, signing everyone out', async (t) => {
  const stateDir = await tmpDir(t);
  savePassphrase(stateDir, 'first-passphrase');
  const before = loadSessionSecret(stateDir);
  const token = createSessionToken(before);
  savePassphrase(stateDir, 'second-passphrase');
  const after = loadSessionSecret(stateDir);
  assert.equal(verifySessionToken(after, token), false);
});

test('createAuth throws when auth is required but no passphrase is configured', () => {
  assert.throws(() => createAuth({ stateDir: '/tmp/does-not-matter', record: null, requireAuth: true, readBody }), /passphrase/);
});

test('createAuth is a no-op (isAuthed always true) with no record and auth not required', () => {
  const auth = createAuth({ stateDir: '/tmp/does-not-matter', record: null, requireAuth: false, readBody });
  assert.equal(auth.enabled, false);
  assert.equal(auth.isAuthed({ headers: {} }), true);
});

function fakeReqRes(body, { contentType = 'application/x-www-form-urlencoded', remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.headers = { 'content-type': contentType };
  req.method = 'POST';
  req.socket = { remoteAddress };
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(chunk) { this.body = chunk; },
  };
  return { req, res };
}

test('full login flow: wrong passphrase 401s, right passphrase sets a verifiable cookie', async (t) => {
  const stateDir = await tmpDir(t);
  const record = savePassphrase(stateDir, 'letmein-letmein');
  const auth = createAuth({ stateDir, record, requireAuth: false, secure: false, readBody });

  {
    const { req, res } = fakeReqRes('passphrase=nope');
    await auth.handleLogin(req, res);
    assert.equal(res.statusCode, 401);
  }
  {
    const { req, res } = fakeReqRes('passphrase=letmein-letmein');
    await auth.handleLogin(req, res);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.Location, './', 'relative, so a /m mount still works');
    const setCookie = res.headers['Set-Cookie'];
    assert.match(setCookie, /dsh_rc_session=/);
    const token = setCookie.match(/dsh_rc_session=([^;]+)/)[1];
    assert.equal(auth.isAuthed({ headers: { cookie: `dsh_rc_session=${token}` } }), true);
    assert.equal(auth.isAuthed({ headers: {} }), false);
  }
});

test('login attempts are rate limited across all addresses', async (t) => {
  const stateDir = await tmpDir(t);
  const record = savePassphrase(stateDir, 'letmein-letmein');
  const auth = createAuth({ stateDir, record, requireAuth: false, secure: false, readBody });
  let lastStatus;
  for (let i = 0; i < 20; i++) {
    const { req, res } = fakeReqRes('passphrase=nope', { remoteAddress: `127.0.0.${i + 1}` });
    await auth.handleLogin(req, res);
    lastStatus = res.statusCode;
  }
  assert.equal(lastStatus, 429);
});
