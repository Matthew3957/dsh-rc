// dsh-rc server: serves public/ on loopback and bridges dsh events to Web Push.
//
// No build step. Started with `node server/index.mjs` or `npm start`.
//
// Routes:
//   GET  /                public/ (static, loopback only)
//   GET  /push/key        VAPID public key
//   POST /push/subscribe  PushSubscription JSON
//   POST /push/unsubscribe { endpoint }
//   POST /push/test       send a test notification to every subscription
//
// It also watches dsh's event sockets and pushes notifications for approvals,
// questions, finished turns and errors. It never POSTs to /api.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import webpush from 'web-push';

import { createNotifier } from './notify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DEFAULT_PORT = 3081;
const DEFAULT_DSH_URL = 'http://127.0.0.1:3080';
const DEFAULT_VAPID_SUBJECT = 'mailto:dsh-rc@localhost';

/** JSON request bodies for /push/* are capped at this many bytes. */
export const BODY_LIMIT = 16 * 1024;
/** More subscriptions than this are refused. */
export const MAX_SUBSCRIPTIONS = 20;
/** Backoff cap for the event sockets. */
export const RECONNECT_CAP_MS = 30000;

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

export function defaultStateDir(env = process.env) {
  if (env.DSH_RC_STATE_DIR) return env.DSH_RC_STATE_DIR;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, 'dsh-rc');
  return path.join(os.homedir(), '.local', 'state', 'dsh-rc');
}

// ---------- State files (0600 files in a 0700 directory) ----------

function ensureStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writeSecret(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

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

async function serveStatic(req, res, publicDir, pathname) {
  const abs = resolveStatic(publicDir, pathname);
  if (!abs) return sendText(res, 403, 'Forbidden');
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  let file = abs;
  if (st.isDirectory()) {
    file = path.join(abs, 'index.html');
    try {
      st = await fsp.stat(file);
    } catch {
      return sendText(res, 404, 'Not found');
    }
  }
  if (!st.isFile()) return sendText(res, 404, 'Not found');

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

function readBody(req, limit = BODY_LIMIT) {
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

// ---------- Watcher ----------

/**
 * Connect to dsh's event sockets, reconnect with capped backoff, and hand
 * notifications to `onNotification`. Read-only: it never POSTs to /api.
 */
export function startWatcher({
  dshUrl = DEFAULT_DSH_URL,
  notifier,
  onNotification = () => {},
  logger = console,
  WebSocketImpl = globalThis.WebSocket,
  reconnectCapMs = RECONNECT_CAP_MS,
} = {}) {
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('This Node has no global WebSocket. dsh-rc needs Node 22 or newer.');
  }
  const wsBase = String(dshUrl).replace(/\/+$/, '').replace(/^http/, 'ws');
  const streams = [
    { label: 'mux', url: `${wsBase}/api/events.mux` },
    { label: 'host', url: `${wsBase}/api/events.host` },
  ];
  const sockets = new Map();
  const timers = new Map();
  const attempts = new Map();
  let stopped = false;

  function open(stream) {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocketImpl(stream.url);
    } catch (err) {
      logger.error(`[dsh-rc] ${stream.label} could not open: ${err.message}`);
      schedule(stream);
      return;
    }
    sockets.set(stream.label, ws);
    ws.onopen = () => {
      attempts.set(stream.label, 0);
      logger.log(`[dsh-rc] ${stream.label} connected`);
    };
    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      let n;
      try {
        n = notifier.handle(frame);
      } catch (err) {
        logger.error(`[dsh-rc] notification mapping failed: ${err.message}`);
        return;
      }
      if (n) Promise.resolve(onNotification(n)).catch((err) => logger.error(`[dsh-rc] push failed: ${err.message}`));
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (stopped) return;
      logger.log(`[dsh-rc] ${stream.label} disconnected, will reconnect`);
      schedule(stream);
    };
  }

  function schedule(stream) {
    if (stopped || timers.has(stream.label)) return;
    const n = attempts.get(stream.label) || 0;
    attempts.set(stream.label, n + 1);
    const wait = Math.min(reconnectCapMs, 1000 * 2 ** Math.min(n, 5));
    const timer = setTimeout(() => {
      timers.delete(stream.label);
      open(stream);
    }, wait);
    if (timer.unref) timer.unref();
    timers.set(stream.label, timer);
  }

  for (const stream of streams) open(stream);

  return {
    stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const ws of sockets.values()) {
        try { ws.close(); } catch { /* already gone */ }
      }
      sockets.clear();
    },
  };
}

// ---------- Server ----------

function createWebPushSender(vapid) {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return { send: (subscription, payload) => webpush.sendNotification(subscription, payload) };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export async function startServer(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const publicDir = options.publicDir || DEFAULT_PUBLIC_DIR;
  const stateDir = options.stateDir || defaultStateDir(env);
  const host = options.host || '127.0.0.1';
  const port = options.port ?? Number(env.DSH_RC_PORT || DEFAULT_PORT);
  const dshUrl = options.dshUrl || env.DSH_URL || DEFAULT_DSH_URL;
  const vapidSubject = options.vapidSubject || env.DSH_RC_VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;
  const watch = options.watch !== false;

  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`refusing to bind ${host}: dsh-rc listens on loopback only`);

  ensureStateDir(stateDir);
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
          logger.error(`[dsh-rc] push send failed: ${(err && err.message) || err}`);
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

  const server = http.createServer((req, res) => {
    (async () => {
      const pathname = requestPath(req.url);
      if (!pathname.startsWith('/')) return sendText(res, 400, 'Bad request');
      if (pathname === '/push' || pathname.startsWith('/push/')) return handlePush(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
      return serveStatic(req, res, publicDir, pathname);
    })().catch((err) => {
      // A client that hangs up mid-download (common on phones) is not a server error.
      if (err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      logger.error(`[dsh-rc] request failed: ${(err && err.message) || err}`);
      if (!res.headersSent) sendText(res, 500, 'Internal error');
      else res.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;

  let watcher = null;
  if (watch) watcher = startWatcher({ dshUrl, notifier, onNotification: deliver, logger });

  logger.log(`[dsh-rc] listening on http://${host}:${actualPort}, state in ${stateDir}`);

  return {
    server,
    port: actualPort,
    host,
    stateDir,
    store,
    vapid,
    notifier,
    deliver,
    async close() {
      if (watcher) watcher.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function main(env = process.env) {
  await startServer({ env });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[dsh-rc] ${(err && err.stack) || err}`);
    process.exit(1);
  });
}
