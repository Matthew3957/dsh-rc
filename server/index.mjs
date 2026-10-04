// dsh-rc server: serves public/, proxies dsh's /api to the same origin, and
// bridges dsh events to Web Push.
//
// No build step. Started with `node server/index.mjs` or `npm start`.
//
// Routes:
//   GET  /                public/ (static)
//   *    /api, /api/*     proxied to $DSH_URL (see server/proxy.mjs)
//   GET  /login           passphrase login page (only when auth is enabled)
//   POST /login           checks the passphrase, sets the session cookie
//   POST /logout          clears the session cookie
//   GET  /push/key        VAPID public key
//   POST /push/subscribe  PushSubscription JSON
//   POST /push/unsubscribe { endpoint }
//   POST /push/test       send a test notification to every subscription
//   GET  /plugin-changes  {toggle}: whether this client may switch connectors (plugin-changes.mjs)
//
// It also watches dsh's event feeds (server/watcher.mjs) and pushes notifications for approvals,
// questions, finished turns and errors. It never changes anything in dsh on its own.
//
// dsh 0.2 wants a signed cookie on every call: give dsh-rc the launch token dsh prints at start
// (DSH_TOKEN, or DSH_TOKEN_FILE / --dsh-token-file) and the proxy and watcher exchange it.
//
// Auth (server/auth.mjs) gates everything except /login and the app-install
// files. The server refuses to start without a passphrase whenever `host` is
// not loopback or the tunnel is on; otherwise login is optional and only
// turns on when a passphrase is configured. Cross-origin writes are refused
// everywhere, and /api has its own Host and Origin checks (server/proxy.mjs).

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import webpush from 'web-push';

import { createNotifier } from './notify.mjs';
import { createDshAuth } from './dsh-auth.mjs';
import { RECONNECT_CAP_MS, startWatcher } from './watcher.mjs';
import { defaultStateDir, ensureStateDir, writeSecret } from './state.mjs';
import { DEFAULT_UPSTREAM_HOST, apiMethodOf, checkRequest, createProxy, hostnameOf, isLoopbackHostname, isPrivilegedMethod } from './proxy.mjs';
import { MIN_PASSPHRASE_LENGTH, createAuth, loadPassphraseRecord, passphraseProblem, savePassphrase } from './auth.mjs';
import { startTunnel } from './tunnel.mjs';
import { LIST_METHOD, PLUGIN_CHANGE_METHODS, parseToggle, pluginChangeRefusal, toggleBody, toggleRefusal } from './plugin-changes.mjs';
import { encode as encodeQr, toTerminalLines } from './qr.mjs';

export { defaultStateDir } from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DEFAULT_PORT = 3081;
const DEFAULT_DSH_URL = 'http://127.0.0.1:3080';
const DEFAULT_VAPID_SUBJECT = 'https://github.com/Matthew3957/dsh-rc';

/** JSON request bodies for /push/* are capped at this many bytes. */
export const BODY_LIMIT = 16 * 1024;
/** More subscriptions than this are refused. */
export const MAX_SUBSCRIPTIONS = 20;
export { RECONNECT_CAP_MS, startWatcher };

/** The WebSockets the proxy relays: dsh 0.1's two event sockets and dsh 0.2's one multiplexed socket. */
const UPGRADE_PATHS = new Set(['/api/events.mux', '/api/events.host', '/api/remote.mux']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const NO_CACHE = new Set(['.html', '.js', '.mjs', '.css']);

// ---------- State files (0600 files in a 0700 directory) ----------

function loadVapid(stateDir, subject) {
  const file = path.join(stateDir, 'vapid.json');
  let keys = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') keys = parsed;
  } catch {
    // Missing or unreadable: generate below.
  }
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    writeSecret(file, JSON.stringify(keys, null, 2) + '\n');
  } else {
    fs.chmodSync(file, 0o600);
  }
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
}

class SubscriptionStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'subscriptions.json');
    this.subs = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.subs = parsed.filter((s) => s && typeof s.endpoint === 'string');
    } catch {
      // Missing or unreadable: start empty.
    }
  }
  list() { return this.subs; }
  size() { return this.subs.length; }
  has(endpoint) { return this.subs.some((s) => s.endpoint === endpoint); }
  add(sub) {
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.subs.push(sub);
    this.save();
  }
  remove(endpoint) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
    return before - this.subs.length;
  }
  save() { writeSecret(this.file, JSON.stringify(this.subs, null, 2) + '\n'); }
}

/** Raw path portion of a request target. Kept undecoded and unnormalized so
 *  the traversal check sees what the client actually sent. */
function requestPath(url) {
  const raw = typeof url === 'string' && url ? url : '/';
  let end = raw.length;
  const q = raw.indexOf('?');
  if (q !== -1 && q < end) end = q;
  const hash = raw.indexOf('#');
  if (hash !== -1 && hash < end) end = hash;
  return raw.slice(0, end) || '/';
}

// ---------- Static files ----------

/** Absolute path for a URL pathname, or null when it escapes publicDir. */
export function resolveStatic(publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const root = path.resolve(publicDir);
  const abs = path.resolve(root, decoded.replace(/^\/+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function sendText(res, status, text, headers = {}) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

function sendJson(res, status, value) {
  const buf = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Where the app is mounted: `/` by default, `/m/` behind Tailscale Serve. A
 *  proxy may strip the mount from the path it forwards, so a same-origin
 *  Referer (the page the user just tapped a link on) is the better signal that
 *  the window is under a path. */
export function appBasePath(pathname, referer, host) {
  if (typeof referer === 'string' && referer) {
    try {
      const ref = new URL(referer);
      if (/^https?:$/.test(ref.protocol) && (!host || ref.host === host)) {
        return ref.pathname.slice(0, ref.pathname.lastIndexOf('/') + 1) || '/';
      }
    } catch {
      // Not a usable URL: fall through to the path.
    }
  }
  const p = String(pathname || '/');
  return (p === '/m' || p.startsWith('/m/')) ? '/m/' : '/';
}

/** A browser page navigation should never hit a bare "Not found": this small
 *  page matches the app's look and offers a way back to whichever root the app
 *  is served from. */
export function notFoundPageHtml(pathname, base = '/') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111416" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f6f7f8" media="(prefers-color-scheme: light)">
<title>Not found · dsh-rc</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f8; --card:#fff; --fg:#16191d; --muted:#69707a; --line:#dde1e6; --accent:#0e7c86; --accent-fg:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111416; --card:#1e2327; --fg:#e6e9ec; --muted:#8b949e; --line:#2b3136; --accent:#3cc4c4; --accent-fg:#0b1f20; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--fg); font:16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width:min(360px, 100%); background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  h1 { margin:0 0 6px; font-size:17px; }
  p { margin:0 0 10px; color:var(--muted); font-size:14px; }
  code { display:block; font-family:ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:12.5px; word-break:break-word; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:9px 11px; margin:0 0 14px; }
  a.home { display:block; text-align:center; text-decoration:none; font-weight:650; background:var(--accent); color:var(--accent-fg); border-radius:10px; padding:11px 12px; }
</style>
</head>
<body>
<main>
  <h1>That page isn't here</h1>
  <p>dsh-rc has no page at this address. It was probably a file path in a message.</p>
  <code>${escapeHtml(pathname)}</code>
  <a class="home" href="${escapeHtml(base)}">Back to dsh-rc</a>
</main>
</body>
</html>
`;
}

function wantsHtml(req) {
  const accept = req.headers.accept || '';
  return /\btext\/html\b/i.test(accept) || req.headers['sec-fetch-mode'] === 'navigate';
}

function sendNotFound(req, res, pathname) {
  if (!wantsHtml(req)) return sendText(res, 404, 'Not found');
  const base = appBasePath(pathname, req.headers.referer, req.headers.host);
  const body = Buffer.from(notFoundPageHtml(pathname, base), 'utf8');
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  return req.method === 'HEAD' ? res.end() : res.end(body);
}

async function serveStatic(req, res, publicDir, pathname) {
  const abs = resolveStatic(publicDir, pathname);
  if (!abs) return sendText(res, 403, 'Forbidden');
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return sendNotFound(req, res, pathname);
  }
  let file = abs;
  if (st.isDirectory()) {
    file = path.join(abs, 'index.html');
    try {
      st = await fsp.stat(file);
    } catch {
      return sendNotFound(req, res, pathname);
    }
  }
  if (!st.isFile()) return sendNotFound(req, res, pathname);

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': NO_CACHE.has(ext) ? 'no-cache' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') return res.end();
  await pipeline(fs.createReadStream(file), res);
}

// ---------- Push request bodies ----------

export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) tooLarge = true;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Keep draining so the client finishes, but stop buffering.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) reject(Object.assign(new Error('body too large'), { code: 'too-large' }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** Push services a browser subscription can point at. Anything else is refused,
 *  so the server never POSTs to an arbitrary URL. */
export const PUSH_SERVICE_HOSTS = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

/** Return an error string for an unusable PushSubscription, or null. */
export function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return 'expected a PushSubscription object';
  if (typeof sub.endpoint !== 'string' || !sub.endpoint) return 'endpoint is required';
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return 'endpoint is not a URL';
  }
  if (url.protocol !== 'https:') return 'endpoint must be https';
  if (!PUSH_SERVICE_HOSTS.some((re) => re.test(url.hostname))) return 'endpoint is not a known push service';
  if (!sub.keys || typeof sub.keys !== 'object') return 'keys are required';
  if (typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return 'keys.p256dh and keys.auth are required';
  return null;
}

// ---------- Server ----------

function createWebPushSender(vapid) {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return { send: (subscription, payload) => webpush.sendNotification(subscription, payload) };
}

const NO_PASSPHRASE_HINT = 'set DSH_RC_PASSPHRASE, or run `node server/index.mjs --set-passphrase`';

function listOption(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

export async function startServer(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const publicDir = options.publicDir || DEFAULT_PUBLIC_DIR;
  const stateDir = options.stateDir || defaultStateDir(env);
  const host = options.host || env.DSH_RC_HOST || '127.0.0.1';
  const port = options.port ?? Number(env.DSH_RC_PORT || DEFAULT_PORT);
  const dshUrl = options.dshUrl || env.DSH_URL || DEFAULT_DSH_URL;
  const upstreamHost = options.upstreamHost || env.DSH_RC_UPSTREAM_HOST || DEFAULT_UPSTREAM_HOST;
  const trustedHosts = listOption(options.trustedHosts ?? env.DSH_RC_TRUSTED_HOSTS);
  const vapidSubject = options.vapidSubject || env.DSH_RC_VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;
  const watch = options.watch !== false;
  const tunnelEnabled = options.tunnel ?? /^(1|true|yes)$/i.test(String(env.DSH_RC_TUNNEL || ''));
  const certFile = options.certFile || env.DSH_RC_CERT;
  const keyFile = options.keyFile || env.DSH_RC_KEY;
  if (!certFile !== !keyFile) throw new Error('https needs both a certificate and a key (--cert and --key)');
  const useHttps = !!certFile;

  ensureStateDir(stateDir);

  // Auth is required whenever anything but this machine can reach the server:
  // a non-loopback bind, or a tunnel (cloudflared connects from loopback, so
  // the bind address alone would not catch it).
  const passphraseRecord = options.passphraseRecord !== undefined ? options.passphraseRecord : loadPassphraseRecord(stateDir, env);
  const loopbackBind = isLoopbackHostname(host.toLowerCase());
  if (!loopbackBind && !passphraseRecord) {
    throw new Error(`refusing to bind ${host} without a passphrase: dsh-rc listens on loopback only unless one is configured (${NO_PASSPHRASE_HINT})`);
  }
  if (tunnelEnabled && !passphraseRecord) {
    throw new Error(
      `refusing to start a tunnel without a passphrase: a quick tunnel has no auth of its own and dsh has none either (${NO_PASSPHRASE_HINT})`,
    );
  }
  const auth = createAuth({
    stateDir,
    record: passphraseRecord,
    requireAuth: !loopbackBind || tunnelEnabled,
    secure: useHttps || tunnelEnabled,
    readBody,
  });
  const dshAuth = createDshAuth({
    dshUrl,
    token: options.dshToken ?? env.DSH_TOKEN,
    tokenFile: options.dshTokenFile || env.DSH_TOKEN_FILE,
    logger,
  });
  const proxy = createProxy({ dshUrl, upstreamHost, logger, dshAuth });
  // Without a login, only loopback (or explicitly trusted) Host names may use
  // the proxy. A reverse proxy or tunnel someone points at a no-login server
  // forwards its public Host and is refused, as are DNS-rebinding pages.
  const fence = { requireLoopbackHost: !auth.enabled, trustedHosts };

  const vapid = loadVapid(stateDir, vapidSubject);
  const store = new SubscriptionStore(stateDir);
  const sender = options.sender || createWebPushSender(vapid);
  const notifier = options.notifier || createNotifier();

  async function deliver(notification) {
    const payload = JSON.stringify(notification);
    let sent = 0;
    let removed = 0;
    for (const sub of [...store.list()]) {
      try {
        await sender.send(sub, payload);
        sent += 1;
      } catch (err) {
        const status = err && (err.statusCode || err.status);
        if (status === 404 || status === 410) {
          store.remove(sub.endpoint);
          removed += 1;
        } else {
          logger.error(`[dsh-rc] push send failed: ${status || ''} ${(err && err.body) || (err && err.message) || err}`.replace(/\s+/g, ' '));
        }
      }
    }
    return { sent, removed };
  }

  async function handlePush(req, res, pathname) {
    if (pathname === '/push/key') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, { key: vapid.publicKey });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    // Requiring JSON forces a CORS preflight, which this server never answers,
    // so other websites cannot drive these endpoints from a visitor's browser.
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      return sendJson(res, 415, { error: 'Content-Type must be application/json' });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err.code === 'too-large') return sendJson(res, 413, { error: 'request body too large' });
      throw err;
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }

    if (pathname === '/push/subscribe') {
      const problem = validateSubscription(body);
      if (problem) return sendJson(res, 400, { error: problem });
      if (!store.has(body.endpoint) && store.size() >= MAX_SUBSCRIPTIONS) {
        return sendJson(res, 400, { error: `too many subscriptions (max ${MAX_SUBSCRIPTIONS})` });
      }
      store.add(body);
      return sendJson(res, 200, { ok: true, count: store.size() });
    }
    if (pathname === '/push/unsubscribe') {
      if (!body || typeof body.endpoint !== 'string') return sendJson(res, 400, { error: 'endpoint is required' });
      const removed = store.remove(body.endpoint);
      return sendJson(res, 200, { ok: true, removed, count: store.size() });
    }
    if (pathname === '/push/test') {
      const result = await deliver({ title: 'dsh-rc', body: 'Test notification', sessionId: null, tag: 'test' });
      return sendJson(res, 200, { ok: true, ...result, count: store.size() });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // A refusal the page can tell from dsh's own 403 (which means "trust this Host"), with the
  // reason it shows in a toast.
  function refusePluginChange(res, status, reason) {
    return sendText(res, status, `Refused: ${reason}`, { 'X-Dsh-Rc-Refused': reason, 'Cache-Control': 'no-store' });
  }

  async function handlePluginChange(req, res, method) {
    const refusal = pluginChangeRefusal(req, { authEnabled: auth.enabled });
    if (refusal) return refusePluginChange(res, 403, refusal);
    if (req.method !== 'POST') return refusePluginChange(res, 405, 'POST only');
    if (method === LIST_METHOD) return proxy.proxyHttp(req, res);
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err.code === 'too-large') return refusePluginChange(res, 413, 'request body too large');
      throw err;
    }
    const toggle = parseToggle(raw);
    if (toggle.error) return refusePluginChange(res, 400, toggle.error);
    let listed;
    try {
      listed = await proxy.callUpstream(LIST_METHOD);
    } catch (err) {
      logger.error(`[dsh-rc] could not read the plugin list before a switch: ${err.message}`);
      return refusePluginChange(res, 502, 'could not read the plugin list from dsh');
    }
    if (!listed.ok) return refusePluginChange(res, 502, 'dsh would not list its plugins');
    const problem = toggleRefusal(listed.value, toggle.id);
    if (problem) return refusePluginChange(res, 403, problem);
    logger.log(`[dsh-rc] switching ${toggle.id} ${toggle.enabled ? 'on' : 'off'} for a client`);
    return proxy.proxyHttp(req, res, { body: toggleBody(toggle) });
  }

  function requestHandler(req, res) {
    (async () => {
      const pathname = requestPath(req.url);
      if (!pathname.startsWith('/')) return sendText(res, 400, 'Bad request');
      const isApi = pathname === '/api' || pathname.startsWith('/api/');
      const isPush = pathname === '/push' || pathname.startsWith('/push/');
      const isTunnel = pathname === '/tunnel';
      const isPluginChanges = pathname === '/plugin-changes';

      // Cross-site writes are refused everywhere, before auth is looked at.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const problem = checkRequest(req);
        if (problem) return sendText(res, 403, `Forbidden: ${problem}`);
      }

      if (pathname === '/login') return auth.handleLogin(req, res);
      if (pathname === '/logout') return auth.handleLogout(req, res);

      if (!auth.isAuthed(req) && !auth.isPublic(req, pathname)) {
        if (isApi || isPush || isTunnel || isPluginChanges) {
          // The header lets the page tell this login 401 from a 401 dsh itself sends (dsh 0.2 wants its own cookie).
          const buf = Buffer.from(JSON.stringify({ error: 'authentication required' }), 'utf8');
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Dsh-Rc-Login': '1' });
          return res.end(buf);
        }
        if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
          res.writeHead(303, { Location: 'login', 'Cache-Control': 'no-store' });
          return res.end();
        }
        return sendText(res, 401, 'Log in first', { 'Cache-Control': 'no-store' });
      }

      if (isApi) {
        const problem = checkRequest(req, fence);
        if (problem) return sendText(res, 403, `Forbidden: ${problem}`);
        const method = apiMethodOf(pathname);
        if (method === null) return sendText(res, 400, 'Bad request');
        if (PLUGIN_CHANGE_METHODS.has(method)) return handlePluginChange(req, res, method);
        if (isPrivilegedMethod(method)) return sendText(res, 403, 'Forbidden: dsh-rc does not proxy settings or credentials methods');
        return proxy.proxyHttp(req, res);
      }
      if (isPush) return handlePush(req, res, pathname);
      if (isPluginChanges) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
        const refusal = checkRequest(req, fence) || pluginChangeRefusal(req, { authEnabled: auth.enabled });
        return sendJson(res, 200, refusal ? { toggle: false, reason: refusal } : { toggle: true });
      }
      if (isTunnel) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
        return sendJson(res, 200, { url: tunnel ? `${tunnel.url}/` : null });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
      return serveStatic(req, res, publicDir, pathname);
    })().catch((err) => {
      // A client that hangs up mid-download (common on phones) is not a server error.
      if (err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      logger.error(`[dsh-rc] request failed: ${(err && err.message) || err}`);
      if (!res.headersSent) sendText(res, 500, 'Internal error');
      else res.destroy();
    });
  }

  const server = useHttps
    ? https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, requestHandler)
    : http.createServer(requestHandler);

  function refuseUpgrade(socket, status, text) {
    if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const pathname = requestPath(req.url);
    if (!UPGRADE_PATHS.has(pathname)) return refuseUpgrade(socket, 404, 'Not Found');
    if (!auth.isAuthed(req)) return refuseUpgrade(socket, 401, 'Unauthorized');
    if (checkRequest(req, fence)) return refuseUpgrade(socket, 403, 'Forbidden');
    proxy.proxyUpgrade(req, socket, head);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;

  let watcher = null;
  if (watch) watcher = startWatcher({ dshUrl, notifier, onNotification: deliver, logger, dshAuth });

  let tunnel = null;
  if (tunnelEnabled) {
    try {
      tunnel = await startTunnel({
        port: actualPort,
        host,
        https: useHttps,
        onExit: (code, signal) => logger.error(`[dsh-rc] cloudflared exited (code ${code}, signal ${signal}); the tunnel is down`),
      });
    } catch (err) {
      if (watcher) watcher.stop();
      await new Promise((resolve) => server.close(resolve));
      throw err;
    }
    logger.log(`[dsh-rc] tunnel: ${tunnel.url}/ (new on every start; anyone with it reaches the login page)`);
    try {
      const ansi = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
      logger.log(toTerminalLines(encodeQr(`${tunnel.url}/`), { ansi }).join('\n'));
    } catch (err) {
      logger.error(`[dsh-rc] could not draw the tunnel QR code: ${err.message}`);
    }
  }

  const shownHost = host.includes(':') ? `[${host}]` : host;
  logger.log(`[dsh-rc] listening on ${useHttps ? 'https' : 'http'}://${shownHost}:${actualPort}, state in ${stateDir}`);
  logger.log(`[dsh-rc] proxying /api to ${dshUrl} as Host ${proxy.presentedHost}; start dsh with --trusted-host ${hostnameOf(proxy.presentedHost)}`);
  logger.log(auth.enabled ? '[dsh-rc] passphrase login is on' : '[dsh-rc] no passphrase configured: login is off (loopback only)');

  return {
    server,
    port: actualPort,
    host,
    stateDir,
    store,
    vapid,
    notifier,
    deliver,
    auth,
    tunnelUrl: tunnel ? tunnel.url : null,
    async close() {
      if (watcher) watcher.stop();
      if (tunnel) tunnel.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------- CLI ----------

/** Ask each prompt in turn without echoing the answers. Resolves with the
 *  answers, or null if input ends first. One interface for all prompts, so
 *  piped input is not lost between them. */
function readSecretLines(prompts) {
  return new Promise((resolve) => {
    let muted = false;
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
    const answers = [];
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(value);
    };
    rl.on('close', () => finish(null));
    const ask = () => {
      if (answers.length === prompts.length) return finish(answers);
      muted = false;
      rl.question(prompts[answers.length], (answer) => {
        process.stdout.write('\n');
        answers.push(answer);
        ask();
      });
      muted = true;
    };
    ask();
  });
}

async function setPassphraseCommand(env = process.env) {
  const stateDir = defaultStateDir(env);
  ensureStateDir(stateDir);
  let passphrase = env.DSH_RC_PASSPHRASE;
  if (!passphrase) {
    const answers = await readSecretLines([`New dsh-rc passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters): `, 'Again: ']);
    if (!answers || answers[0] !== answers[1]) {
      console.error(answers ? '[dsh-rc] the two entries differ, nothing written' : '[dsh-rc] no passphrase given, nothing written');
      process.exitCode = 1;
      return;
    }
    passphrase = answers[0];
  }
  const problem = passphraseProblem(passphrase);
  if (problem) {
    console.error(`[dsh-rc] ${problem}, nothing written`);
    process.exitCode = 1;
    return;
  }
  savePassphrase(stateDir, passphrase);
  console.log(`[dsh-rc] passphrase saved to ${path.join(stateDir, 'passphrase.json')}; existing logins are signed out`);
}

const USAGE = `Usage: node server/index.mjs [options]
  --host <addr>           bind address (default 127.0.0.1; anything else needs a passphrase)
  --port <n>              port (default ${DEFAULT_PORT})
  --dsh-url <url>         dsh web base URL (default ${DEFAULT_DSH_URL})
  --upstream-host <name>  Host the proxy presents to dsh (default ${DEFAULT_UPSTREAM_HOST})
  --dsh-token-file <file> file holding the launch token dsh 0.2 prints at start (or set DSH_TOKEN)
  --trusted-host <name>   extra Host allowed without a login (repeatable, private networks only)
  --tunnel                start a Cloudflare quick tunnel (needs cloudflared and a passphrase)
  --cert <file>           certificate for serving https directly (with --key)
  --key <file>            private key for --cert
  --set-passphrase        store a hashed passphrase in the state dir and exit`;

export function parseCliArgs(argv) {
  const options = {};
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--set-passphrase') options.setPassphrase = true;
    else if (arg === '--tunnel') options.tunnel = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--host') options.host = value(++i, arg);
    else if (arg === '--port') {
      options.port = Number(value(++i, arg));
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error(`bad --port\n${USAGE}`);
    } else if (arg === '--cert') options.certFile = value(++i, arg);
    else if (arg === '--key') options.keyFile = value(++i, arg);
    else if (arg === '--dsh-url') options.dshUrl = value(++i, arg);
    else if (arg === '--upstream-host') options.upstreamHost = value(++i, arg);
    else if (arg === '--dsh-token-file') options.dshTokenFile = value(++i, arg);
    else if (arg === '--trusted-host') (options.trustedHosts ||= []).push(value(++i, arg));
    else throw new Error(`unknown option ${arg}\n${USAGE}`);
  }
  return options;
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const { setPassphrase, help, ...cli } = parseCliArgs(argv);
  if (help) {
    console.log(USAGE);
    return;
  }
  if (setPassphrase) {
    await setPassphraseCommand(env);
    return;
  }
  const app = await startServer({ env, ...cli });
  // Stop cloudflared with the server instead of leaving it running.
  const shutdown = () => app.close().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[dsh-rc] ${(err && err.message) || err}`);
    process.exit(1);
  });
}
