// The push watcher: connects to dsh's event feeds, turns their frames into notifications.
//
// Two dsh generations, told apart on every (re)connect because dsh may be restarted as the
// other one:
//   - dsh 0.1: two sockets, /api/events.mux and /api/events.host, each frame already the shape
//     createNotifier().handle() wants.
//   - dsh 0.2: one /api/remote.mux socket with two logical streams, `$events` (session status,
//     errors, and the approval and question waterfalls) and `session/control` (titles). The
//     frames are mapped to the 0.1 shapes by public/dsh02.js, so the notifier is shared.
//
// Read-only. It never answers a waterfall and never POSTs a method that changes anything, so
// to dsh it is one more open tab that has not answered yet (which is how 0.1's watcher behaved
// too). dsh 0.2 needs a signed cookie on the socket: see dsh-auth.mjs.

import { fromControl, fromEvents } from '../public/dsh02.js';

/** Backoff cap for the event sockets. */
export const RECONNECT_CAP_MS = 30000;

const DEFAULT_DSH_URL = 'http://127.0.0.1:3080';

/** POST one client-request to dsh and return the parsed result, or throw with `.status`. */
async function probe(dshUrl, method, payload, cookie, fetchImpl) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetchImpl(`${String(dshUrl).replace(/\/+$/, '')}/api/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'client-request', rpcId: `watch-${Date.now()}`, method, payload }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw Object.assign(new Error(`${method}: HTTP ${res.status}`), { status: res.status });
  const body = await res.json();
  if (!body.result || !body.result.ok) throw Object.assign(new Error(`${method} failed`), { status: 200 });
  return body.result.value;
}

/** Which dsh answers at `dshUrl`: 1 for 0.1, 2 for 0.2 (with the cookie it needs), or null. */
export async function detectDsh({ dshUrl, dshAuth = null, fetchImpl = globalThis.fetch }) {
  try {
    await probe(dshUrl, 'host.describe', {}, null, fetchImpl);
    return { version: 1, cookie: null };
  } catch { /* not 0.1 */ }
  const authority = new URL(dshUrl).host;
  const cookie = dshAuth ? await dshAuth.cookieFor(authority) : null;
  try {
    await probe(dshUrl, 'session/canOpenWorkspacePath', { args: {} }, cookie, fetchImpl);
    return { version: 2, cookie };
  } catch (err) {
    if (err.status === 401 && dshAuth) dshAuth.invalidate(authority);
    return { version: null, cookie: null, status: err.status };
  }
}

/**
 * Connect to dsh's event feeds, reconnect with capped backoff, and hand notifications to
 * `onNotification`.
 */
export function startWatcher({
  dshUrl = DEFAULT_DSH_URL,
  notifier,
  onNotification = () => {},
  logger = console,
  WebSocketImpl = globalThis.WebSocket,
  reconnectCapMs = RECONNECT_CAP_MS,
  dshAuth = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('This Node has no global WebSocket. dsh-rc needs Node 22 or newer.');
  }
  const wsBase = String(dshUrl).replace(/\/+$/, '').replace(/^http/, 'ws');
  let sockets = [];
  let timer = null;
  let attempts = 0;
  let stopped = false;
  let warnedAbout = null;

  function deliver(frame) {
    let n;
    try {
      n = notifier.handle(frame);
    } catch (err) {
      logger.error(`[dsh-rc] notification mapping failed: ${err.message}`);
      return;
    }
    if (n) Promise.resolve(onNotification(n)).catch((err) => logger.error(`[dsh-rc] push failed: ${err.message}`));
  }

  function parse(event) {
    try {
      return JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return null;
    }
  }

  function teardown() {
    const old = sockets;
    sockets = [];
    for (const ws of old) {
      ws.onclose = null;
      try { ws.close(); } catch { /* already gone */ }
    }
  }

  function retry() {
    if (stopped || timer) return;
    teardown();
    const wait = Math.min(reconnectCapMs, 1000 * 2 ** Math.min(attempts++, 5));
    timer = setTimeout(() => {
      timer = null;
      start();
    }, wait);
    if (timer.unref) timer.unref();
  }

  function watch01() {
    for (const label of ['mux', 'host']) {
      let ws;
      try {
        ws = new WebSocketImpl(`${wsBase}/api/events.${label}`);
      } catch (err) {
        logger.error(`[dsh-rc] ${label} could not open: ${err.message}`);
        return retry();
      }
      sockets.push(ws);
      ws.onopen = () => {
        attempts = 0;
        logger.log(`[dsh-rc] ${label} connected`);
      };
      ws.onmessage = (event) => {
        const frame = parse(event);
        if (frame) deliver(frame);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (stopped) return;
        logger.log(`[dsh-rc] ${label} disconnected, will reconnect`);
        retry();
      };
    }
  }

  function watch02(cookie) {
    let ws;
    try {
      ws = cookie ? new WebSocketImpl(`${wsBase}/api/remote.mux`, { headers: { Cookie: cookie } }) : new WebSocketImpl(`${wsBase}/api/remote.mux`);
    } catch (err) {
      logger.error(`[dsh-rc] remote.mux could not open: ${err.message}`);
      return retry();
    }
    sockets.push(ws);
    const pending = new Map(); // waterfall eventId -> kind, for the cancel items
    const notified = new Set(); // a reconnect replays pending waterfalls; tell the phone once
    ws.onopen = () => {
      attempts = 0;
      logger.log('[dsh-rc] remote.mux connected');
      ws.send(JSON.stringify({ type: 'open', streamId: 'ev', endpoint: '$events', payload: { args: {} } }));
      ws.send(JSON.stringify({ type: 'open', streamId: 'ctl', endpoint: 'session/control', payload: { args: {} } }));
    };
    ws.onmessage = (event) => {
      const m = parse(event);
      if (!m) return;
      if (m.type === 'error') {
        logger.error(`[dsh-rc] remote.mux stream ${m.streamId} failed: ${(m.error && m.error.message) || 'unknown'}`);
        return retry();
      }
      if (m.type !== 'item') return;
      const frames = m.streamId === 'ev' ? fromEvents(m.value, pending) : m.streamId === 'ctl' ? fromControl(m.value) : [];
      for (const f of frames) {
        const p = f.payload;
        if (p.type === 'approval/requested' || p.type === 'question/requested') {
          const id = f.env && f.env.rpcId;
          if (notified.has(id)) continue;
          notified.add(id);
        }
        deliver({ payload: p });
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (stopped) return;
      logger.log('[dsh-rc] remote.mux disconnected, will reconnect');
      retry();
    };
  }

  async function start() {
    if (stopped) return;
    const found = await detectDsh({ dshUrl, dshAuth, fetchImpl });
    if (stopped) return;
    if (!found.version) {
      const why = found.status === 401 ? 'dsh wants its launch token (DSH_TOKEN)' : 'dsh did not answer';
      if (warnedAbout !== why) logger.error(`[dsh-rc] watcher waiting: ${why}`);
      warnedAbout = why;
      return retry();
    }
    warnedAbout = null;
    if (found.version === 1) watch01();
    else watch02(found.cookie);
  }

  start();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      teardown();
    },
  };
}
