// Passphrase login and signed session cookies.
//
// A session is a `<expiry>.<hmac>` token, HMAC-SHA256 over the expiry with a
// random secret kept in the state dir (0600). The cookie is HttpOnly,
// SameSite=Strict and Secure whenever the connection is https or a tunnel is
// in front of it. `--set-passphrase` replaces the secret, which logs out every
// device. The passphrase itself is never stored in the clear: either it lives
// in DSH_RC_PASSPHRASE (hashed in memory at startup) or a scrypt hash lives in
// the state dir, written by `--set-passphrase`.
//
// Redirects and the login form use relative URLs, so login also works when
// the server is mounted under a path (Tailscale Serve at /m).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeSecret } from './state.mjs';

export const SESSION_COOKIE = 'dsh_rc_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const LOGIN_BODY_LIMIT = 4 * 1024;
/** A tunnel or reverse proxy makes every client look like 127.0.0.1, so login
 *  attempts are limited globally, not per address. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const SCRYPT_KEYLEN = 64;
/** Shorter passphrases are refused: behind a tunnel this is the only thing
 *  between the internet and a shell. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Paths served without a session, so the browser can install the page as an
 *  app (it fetches the manifest and icons without cookies). */
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/icon.svg', '/icon-180.png', '/icon-512.png']);

export function passphraseProblem(passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) return 'no passphrase given';
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) return `the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`;
  return null;
}

// ---------- Passphrase hashing ----------

export function hashPassphrase(passphrase) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function verifyPassphrase(passphrase, record) {
  if (!record || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  const expected = Buffer.from(record.hash, 'hex');
  const derived = crypto.scryptSync(passphrase, Buffer.from(record.salt, 'hex'), expected.length);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function passphraseFile(stateDir) {
  return path.join(stateDir, 'passphrase.json');
}

/** Write a scrypt hash of `passphrase` to the state dir (0600) and drop the
 *  session secret, so sessions signed under the old passphrase stop working. */
export function savePassphrase(stateDir, passphrase) {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const record = hashPassphrase(passphrase);
  writeSecret(passphraseFile(stateDir), JSON.stringify(record, null, 2) + '\n');
  fs.rmSync(sessionSecretFile(stateDir), { force: true });
  return record;
}

/**
 * The configured passphrase hash, or null when none is configured. The
 * state-dir file takes precedence; DSH_RC_PASSPHRASE is hashed fresh on
 * every call (it is never written to disk on its own).
 */
export function loadPassphraseRecord(stateDir, env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(passphraseFile(stateDir), 'utf8'));
    if (parsed && typeof parsed.salt === 'string' && typeof parsed.hash === 'string') return parsed;
  } catch {
    // Missing, unreadable, or malformed: fall through to the env var.
  }
  if (typeof env.DSH_RC_PASSPHRASE === 'string' && env.DSH_RC_PASSPHRASE) {
    const problem = passphraseProblem(env.DSH_RC_PASSPHRASE);
    if (problem) throw new Error(`DSH_RC_PASSPHRASE: ${problem}`);
    return hashPassphrase(env.DSH_RC_PASSPHRASE);
  }
  return null;
}

// ---------- Session tokens ----------

function sessionSecretFile(stateDir) {
  return path.join(stateDir, 'session-secret');
}

export function loadSessionSecret(stateDir) {
  const file = sessionSecretFile(stateDir);
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  } catch {
    // Missing or unreadable: generate below.
  }
  const secret = crypto.randomBytes(32);
  writeSecret(file, secret.toString('hex') + '\n');
  return secret;
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function createSessionToken(secret, { ttlMs = SESSION_TTL_MS, now = Date.now() } = {}) {
  const payload = String(now + ttlMs);
  return `${payload}.${hmac(secret, payload)}`;
}

export function verifySessionToken(secret, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(secret, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && now <= exp;
}

// ---------- Cookies ----------

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[name] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

export function sessionCookieHeader(token, { secure, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader({ secure } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ---------- Login attempt rate limiting ----------

/** A fixed-window counter. One instance guards every login attempt. */
export function createRateLimiter({ windowMs = RATE_LIMIT_WINDOW_MS, max = RATE_LIMIT_MAX_ATTEMPTS, now = () => Date.now() } = {}) {
  let start = -Infinity;
  let count = 0;
  return {
    allow() {
      const t = now();
      if (t - start > windowMs) {
        start = t;
        count = 0;
      }
      count += 1;
      return count <= max;
    },
  };
}

// ---------- Login page ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function loginPageHtml({ error } = {}) {
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-rc login</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #111; color: #eee; }
  form { display: grid; gap: 12px; width: min(320px, 90vw); }
  input { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #444; background: #1c1c1c; color: inherit; }
  button { font: inherit; padding: 10px 12px; border-radius: 8px; border: none; background: #3b82f6; color: #fff; }
  .error { color: #f87171; margin: 0; }
  h1 { font-size: 1.1rem; margin: 0 0 4px; }
</style>
</head>
<body>
<form method="post" action="login">
  <h1>dsh-rc</h1>
  ${message}
  <input type="password" name="passphrase" placeholder="Passphrase" autocomplete="current-password" autofocus required>
  <button type="submit">Log in</button>
</form>
</body>
</html>
`;
}

// ---------- Middleware ----------

function sendLoginPage(req, res, status, error) {
  const body = Buffer.from(loginPageHtml({ error }), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  return req.method === 'HEAD' ? res.end() : res.end(body);
}

/**
 * Build the auth layer for a server instance. `record` is the loaded
 * passphrase hash (or null, meaning auth is off). `requireAuth` set with no
 * `record` throws, since binding beyond loopback or turning on the tunnel
 * without a passphrase would hand out shell access to anyone who reaches it.
 */
export function createAuth({ stateDir, record, requireAuth = false, secure = false, readBody }) {
  if (requireAuth && !record) {
    throw new Error(
      'refusing to start without a passphrase: set DSH_RC_PASSPHRASE or run `--set-passphrase` before binding beyond loopback or enabling --tunnel',
    );
  }
  const enabled = !!record;
  const secret = enabled ? loadSessionSecret(stateDir) : null;
  const limiter = createRateLimiter();

  function isAuthed(req) {
    if (!enabled) return true;
    const cookies = parseCookies(req.headers.cookie);
    return verifySessionToken(secret, cookies[SESSION_COOKIE]);
  }

  /** True for paths anyone may fetch: the login page and the app-install files. */
  function isPublic(req, pathname) {
    if (pathname === '/login') return true;
    return (req.method === 'GET' || req.method === 'HEAD') && PUBLIC_PATHS.has(pathname);
  }

  async function handleLogin(req, res) {
    if (!enabled) {
      res.writeHead(303, { Location: './', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' || req.method === 'HEAD') return sendLoginPage(req, res, 200);
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Method not allowed');
    }
    if (!limiter.allow()) return sendLoginPage(req, res, 429, 'Too many attempts. Wait a minute and try again.');
    let raw;
    try {
      raw = await readBody(req, LOGIN_BODY_LIMIT);
    } catch {
      raw = '';
    }
    let passphrase = '';
    const contentType = req.headers['content-type'] || '';
    if (/application\/json/i.test(contentType)) {
      try {
        passphrase = JSON.parse(raw || '{}').passphrase || '';
      } catch {
        passphrase = '';
      }
    } else {
      passphrase = new URLSearchParams(raw).get('passphrase') || '';
    }
    if (typeof passphrase !== 'string' || !passphrase || !verifyPassphrase(passphrase, record)) {
      return sendLoginPage(req, res, 401, 'Wrong passphrase.');
    }
    const token = createSessionToken(secret);
    res.writeHead(303, {
      Location: './',
      'Set-Cookie': sessionCookieHeader(token, { secure }),
      'Cache-Control': 'no-store',
    });
    res.end();
  }

  function handleLogout(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Method not allowed');
    }
    res.writeHead(303, { Location: 'login', 'Set-Cookie': clearCookieHeader({ secure }), 'Cache-Control': 'no-store' });
    res.end();
  }

  return { enabled, isAuthed, isPublic, handleLogin, handleLogout };
}
