// Reverse proxy for dsh's HTTP RPC (`/api/*`) and event WebSockets (dsh 0.1:
// `/api/events.mux`, `/api/events.host`; dsh 0.2: `/api/remote.mux`), so one
// process is the whole front door instead of relying on Tailscale Serve path mounting.
//
// dsh 0.2 also wants a signed cookie on every call and socket. When a launch token is
// configured (see dsh-auth.mjs) the proxy exchanges it for that cookie and adds it to each
// request it relays, so the browser never holds it.
//
// The upstream is always the fixed `dshUrl` this process was started with,
// never anything taken from the incoming request. Bodies are streamed both
// ways, never buffered, and redirects from dsh are relayed, never followed.
//
// Host and Origin. dsh answers 403 unless Host is loopback or one of its
// `--trusted-host` names, and it keeps a privileged method set (settings,
// credentials, host.openPath, ...) for loopback Hosts only. Rewriting Host to
// 127.0.0.1 would hand that set to every phone, tunnel visitor and LAN guest,
// so the proxy presents a dedicated non-loopback name instead
// (DEFAULT_UPSTREAM_HOST, override with DSH_RC_UPSTREAM_HOST) and dsh must be
// started with `--trusted-host` for it. dsh's own fence then keeps the
// privileged set away from the proxy. The proxy also refuses that set itself,
// as a second layer in case the name is misconfigured.
//
// Before rewriting, `checkRequest` enforces the same rules dsh would have
// applied to the browser's real headers: an Origin must match the Host it
// was sent to (no cross-site requests or WebSockets), and without a login
// the Host must be loopback or explicitly trusted (DNS rebinding).

import http from 'node:http';
import https from 'node:https';

import { SESSION_COOKIE } from './auth.mjs';

export const DEFAULT_UPSTREAM_HOST = 'dsh-rc.internal';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** dsh methods that are loopback-only in dsh itself. The page never calls
 *  them; the proxy refuses them whatever Host it presents. */
const PRIVILEGED_METHOD = new RegExp(
  [
    // dsh 0.1: `settings.get`, `host.openPath`, ...
    '^(settings|credentials)[./]',
    '^host[./](pickDirectory|openPath)$',
    '^agentPreset[./](read|copy|openDocument|remove)$',
    // dsh 0.2: `<namespace>/<method>`. Nothing the page calls is in this list.
    '^(pluginManager|dynamicCordisRunner|terminal|account|llm|speech)/',
    '^directoryPicker/(pick|createDirectory)$',
    '^agentPresets/read$',
    '^session/(openWorkspacePath|workspacePathApplications)$',
  ].join('|'),
  'i',
);

/** Hostname part of a Host header or authority, lowercased, or null. */
export function hostnameOf(authority) {
  if (typeof authority !== 'string' || !authority) return null;
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Normalized `host[:port]` of an authority, or null. */
function normalizeAuthority(authority) {
  if (typeof authority !== 'string' || !authority) return null;
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname) {
  if (!hostname) return false;
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * Validate an incoming /api request or upgrade before it is proxied. Returns
 * null when it may pass, or a reason string for a 403.
 *
 * `trustedHosts` are extra Host names (`host` or `host:port`) accepted when
 * there is no login; `requireLoopbackHost` is true when there is no login.
 */
export function checkRequest(req, { requireLoopbackHost = false, trustedHosts = [] } = {}) {
  const host = normalizeAuthority(req.headers.host);
  if (!host) return 'missing or malformed Host';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost = null;
    try {
      const url = new URL(origin);
      if (url.protocol === 'http:' || url.protocol === 'https:') originHost = url.host.toLowerCase();
    } catch {
      // "null" or garbage: refused below.
    }
    // Compare authorities, not schemes: behind a tunnel or TLS proxy the
    // browser's https origin reaches this server over plain http. Ports count,
    // so another app on localhost is a different origin.
    if (originHost !== host) return 'cross-origin request';
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 'cross-site request';
  if (requireLoopbackHost) {
    const hostname = hostnameOf(host);
    // `host:port` entries match exactly, bare names match any port.
    const trusted = trustedHosts.some((entry) => {
      const want = normalizeAuthority(entry);
      if (!want) return false;
      return new URL(`http://${want}`).port ? want === host : hostnameOf(want) === hostname;
    });
    if (!isLoopbackHostname(hostname) && !trusted) {
      return `Host ${host} is not loopback: set a passphrase, or add it with --trusted-host if it is a private network name`;
    }
  }
  return null;
}

/** The dsh method a request path names, or null for a path the proxy refuses. */
export function apiMethodOf(pathname) {
  if (pathname === '/api') return '';
  if (!pathname.startsWith('/api/')) return null;
  const rest = pathname.slice('/api/'.length);
  // No dot segments, encoded separators or backslashes: dsh must see the same
  // method the checks here saw.
  if (/(^|\/)\.\.?(\/|$)|%|\\/.test(rest)) return null;
  return rest;
}

export function isPrivilegedMethod(method) {
  return PRIVILEGED_METHOD.test(method);
}

/** Strip hop-by-hop headers for a plain request/response relay. */
function filterHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/** Drop this server's session cookie so it never reaches dsh. */
function stripSessionCookie(cookie) {
  if (!cookie) return undefined;
  const kept = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${SESSION_COOKIE}=`));
  return kept.length ? kept.join('; ') : undefined;
}

function headerBlock(headers) {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\r\n');
}

export function createProxy({ dshUrl, upstreamHost = DEFAULT_UPSTREAM_HOST, logger = console, dshAuth = null }) {
  const upstream = new URL(dshUrl);
  const mod = upstream.protocol === 'https:' ? https : http;
  const presentedHost = normalizeAuthority(upstreamHost);
  if (!presentedHost) throw new Error(`upstream Host ${JSON.stringify(upstreamHost)} is not a host[:port]`);
  if (isLoopbackHostname(hostnameOf(presentedHost))) {
    throw new Error(
      `upstream Host ${presentedHost} is loopback: dsh would grant proxied requests its loopback-only settings and credentials methods`,
    );
  }
  const presentedOrigin = `${upstream.protocol}//${presentedHost}`;
  let warned403 = false;

  function upstreamOptions(req, { forUpgrade = false, dshCookie = null } = {}) {
    const headers = filterHeaders(req.headers);
    if (forUpgrade) {
      headers.connection = 'Upgrade';
      headers.upgrade = req.headers.upgrade;
    }
    headers.host = presentedHost;
    if (headers.origin !== undefined) headers.origin = presentedOrigin;
    // With a launch token the browser's cookies are not dsh's: dsh-rc's own login cookie is dropped
    // and the cookie dsh issued to this process goes in its place.
    const cookie = dshAuth && dshAuth.enabled ? dshCookie : stripSessionCookie(headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    return {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    };
  }

  function note403(status) {
    if (status !== 403 || warned403) return;
    warned403 = true;
    logger.error(
      `[dsh-rc] dsh answered 403 to a proxied request. Start dsh with --trusted-host ${hostnameOf(presentedHost)} ` +
        'so it accepts the Host the proxy presents.',
    );
  }

  /** Proxy a plain HTTP request (`/api/<method>`, `/api/respond`, ...). */
  function proxyHttp(req, res) {
    Promise.resolve(dshAuth ? dshAuth.cookieFor(presentedHost) : null)
      .catch(() => null)
      .then((dshCookie) => relayHttp(req, res, dshCookie));
  }

  function relayHttp(req, res, dshCookie) {
    const upstreamReq = mod.request(upstreamOptions(req, { dshCookie }), (upstreamRes) => {
      note403(upstreamRes.statusCode);
      if (upstreamRes.statusCode === 401 && dshAuth) dshAuth.invalidate(presentedHost);
      const out = filterHeaders(upstreamRes.headers);
      // Tell the page which name dsh must trust: behind the proxy it is the presented Host,
      // not the hostname in the address bar, so the 403 help card can say so.
      if (upstreamRes.statusCode === 403) out['x-dsh-rc-trusted-host'] = hostnameOf(presentedHost);
      res.writeHead(upstreamRes.statusCode, out);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', (err) => {
      logger.error(`[dsh-rc] proxy request failed: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad gateway');
      } else {
        res.destroy();
      }
    });
    // A client that hangs up mid-request should not leave the upstream socket open.
    res.on('close', () => upstreamReq.destroy());
    req.on('error', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }

  /** Proxy a WebSocket upgrade (`/api/events.mux`, `/api/events.host`, `/api/remote.mux`). */
  function proxyUpgrade(req, socket, head) {
    let gone = false;
    socket.once('close', () => { gone = true; });
    Promise.resolve(dshAuth ? dshAuth.cookieFor(presentedHost) : null)
      .catch(() => null)
      .then((dshCookie) => {
        if (!gone) relayUpgrade(req, socket, head, dshCookie);
      });
  }

  function relayUpgrade(req, socket, head, dshCookie) {
    const upstreamReq = mod.request(upstreamOptions(req, { forUpgrade: true, dshCookie }));
    socket.on('error', () => upstreamReq.destroy());
    socket.on('close', () => upstreamReq.destroy());
    upstreamReq.on('error', (err) => {
      logger.error(`[dsh-rc] proxy upgrade failed: ${err.message}`);
      if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
    });
    upstreamReq.on('response', (upstreamRes) => {
      // Upstream answered without upgrading (e.g. a 403 from dsh's Host check).
      // Relay it instead of leaving the browser's WebSocket hanging.
      note403(upstreamRes.statusCode);
      if (upstreamRes.statusCode === 401 && dshAuth) dshAuth.invalidate(presentedHost);
      const headers = { ...filterHeaders(upstreamRes.headers), connection: 'close' };
      if (socket.writable) {
        socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ''}\r\n${headerBlock(headers)}\r\n\r\n`);
      }
      upstreamRes.pipe(socket);
    });
    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      if (!socket.writable) {
        upstreamSocket.destroy();
        return;
      }
      const headers = filterHeaders(upstreamRes.headers);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headerBlock(headers)}\r\n\r\n`);
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
      if (head && head.length) upstreamSocket.write(head);
      // Either side going away tears down the other.
      upstreamSocket.on('error', () => socket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstreamReq.end();
  }

  return { proxyHttp, proxyUpgrade, upstream, presentedHost };
}
