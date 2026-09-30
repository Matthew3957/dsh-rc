// The launch-token handshake dsh 0.2 wants before it answers anything.
//
// dsh 0.2 prints `http://127.0.0.1:<port>/?token=...` at start. Opening that URL answers a 303
// with a signed `dsh-auth-*` cookie (HttpOnly, 30 days) that is bound to the authority (the Host
// header) the exchange was made with, so the cookie for the name the proxy presents to dsh is not
// the cookie for the watcher's loopback connection. The token itself can be exchanged repeatedly.
//
// This module does that exchange server-side and keeps the cookies, so the browser never holds
// dsh's credential: it only has dsh-rc's own login. With no token configured every method
// returns null and nothing changes for dsh 0.1, which has no such gate.
//
// The token is read on every exchange when it comes from a file, so a supervisor can rewrite the
// file when dsh restarts with a new one.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

/** Refresh a cookie this long before dsh says it expires. */
const EXPIRY_MARGIN_MS = 60 * 60 * 1000;
/** Do not hammer dsh with exchanges when the token is wrong. */
const RETRY_AFTER_FAILURE_MS = 10 * 1000;

/** `name=value` pairs of a Set-Cookie list, with their earliest expiry (ms epoch) or null. */
export function parseSetCookies(setCookies, now = Date.now()) {
  const pairs = [];
  let expires = null;
  for (const line of setCookies || []) {
    const parts = String(line).split(';').map((p) => p.trim());
    if (!parts[0] || !parts[0].includes('=')) continue;
    pairs.push(parts[0]);
    // Max-Age wins over Expires (RFC 6265 5.3), but either one bounds the cookie's life.
    let maxAge = null, at = null;
    for (const attr of parts.slice(1)) {
      const m = /^max-age=(-?\d+)$/i.exec(attr);
      if (m) maxAge = now + Number(m[1]) * 1000;
      const e = /^expires=(.+)$/i.exec(attr);
      if (e) { const t = Date.parse(e[1]); if (Number.isFinite(t)) at = t; }
    }
    const until = maxAge ?? at;
    if (until != null) expires = Math.min(expires ?? Infinity, until);
  }
  return { cookie: pairs.join('; '), expires };
}

/** The token from a bare token, or from the `?token=` of the URL dsh printed. */
export function tokenFrom(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).searchParams.get('token') || null;
    } catch {
      return null;
    }
  }
  return raw;
}

function exchangeRequest(dshUrl, host, token) {
  const base = new URL(dshUrl);
  const mod = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        method: 'GET',
        path: `/?token=${encodeURIComponent(token)}`,
        headers: { host },
        timeout: 10000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] || [] }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('token exchange timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * @param {object} options
 * @param {string} options.dshUrl       dsh web base URL
 * @param {string} [options.token]      launch token (or the URL dsh printed)
 * @param {string} [options.tokenFile]  file holding the token, read on every exchange
 * @param {Function} [options.exchange] (dshUrl, host, token) => {status, setCookie}, for tests
 */
export function createDshAuth({ dshUrl, token, tokenFile, logger = console, exchange = exchangeRequest, now = () => Date.now() } = {}) {
  const jar = new Map(); // authority -> { cookie, expires } | { failedAt }
  const inflight = new Map();

  function currentToken() {
    if (tokenFile) {
      try {
        return tokenFrom(fs.readFileSync(tokenFile, 'utf8'));
      } catch (err) {
        logger.error(`[dsh-rc] cannot read the dsh token file: ${err.code || err.message}`);
        return null;
      }
    }
    return tokenFrom(token);
  }

  const enabled = !!(token || tokenFile);

  async function refresh(authority) {
    const tok = currentToken();
    if (!tok) return null;
    let res;
    try {
      res = await exchange(dshUrl, authority, tok);
    } catch (err) {
      logger.error(`[dsh-rc] dsh token exchange failed: ${err.message}`);
      jar.set(authority, { failedAt: now() });
      return null;
    }
    const { cookie, expires } = parseSetCookies(res.setCookie, now());
    if (res.status >= 400 || !cookie) {
      logger.error(`[dsh-rc] dsh refused the launch token (HTTP ${res.status}); pass the token of the dsh that is running now`);
      jar.set(authority, { failedAt: now() });
      return null;
    }
    jar.set(authority, { cookie, expires });
    return cookie;
  }

  return {
    enabled,
    /** The Cookie header value dsh wants for requests made with this Host, or null. */
    async cookieFor(authority) {
      if (!enabled) return null;
      const hit = jar.get(authority);
      if (hit && hit.cookie && (hit.expires == null || hit.expires - EXPIRY_MARGIN_MS > now())) return hit.cookie;
      if (hit && hit.failedAt && now() - hit.failedAt < RETRY_AFTER_FAILURE_MS) return null;
      if (!inflight.has(authority)) inflight.set(authority, refresh(authority).finally(() => inflight.delete(authority)));
      return inflight.get(authority);
    },
    /** dsh answered 401 to this cookie: forget it so the next call exchanges again. */
    invalidate(authority) {
      jar.delete(authority);
    },
  };
}
