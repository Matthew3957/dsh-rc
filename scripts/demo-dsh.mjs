#!/usr/bin/env node
// A deterministic mock of the dsh web API that replays hand-written demo sessions
// (scripts/demo-fixtures.mjs). It exists so the README screenshots come from a source
// that is obviously not a real instance, and so the same pictures can be made again.
//
// It speaks the subset of the dsh 0.1 API that public/app.js reads, in the shapes of
// the zod schemas in @deepseek-ai/dsh-host-apiproxy/lib/types/api:
//   POST /api/<method>            client-request in, server-response out (rpc.d.ts)
//   POST /api/respond             client-response in, receipt out
//   WS   /api/events.mux|host     server-request frames (events.d.ts)
// Reads are served from the fixtures. The few writes the page can send (prompt, cancel,
// queue edits, answering an approval or a plan) are acknowledged and change nothing,
// except that answering the pending approval or plan clears it. Any method not listed in
// METHODS answers 404 "not found", like an unknown method on dsh.
//
// Usage:
//   node scripts/demo-dsh.mjs [--port 3180] [--now <epoch ms>]
//   then: node server/index.mjs --dsh-url http://127.0.0.1:3180
//   POST /__demo/pending {"approval":true,"plan":true} raises the two waiting cards.
// It binds to loopback only.

import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildDemo, ID } from './demo-fixtures.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------- a minimal WebSocket server (text frames out, control frames in) ----------

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function attachSocket(socket, onClose) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      off += masked ? 4 : 0;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { socket.end(frame(0x8, Buffer.alloc(0))); return; }
      if (opcode === 0x9) socket.write(frame(0xa, payload));
      // Text and binary frames from the page are ignored: the streams are push-only.
    }
  });
  socket.on('close', onClose);
  socket.on('error', () => {});
  return { send: (text) => { if (socket.writable) socket.write(frame(0x1, Buffer.from(text))); } };
}

// ---------- the server ----------

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
const ok = (value) => ({ ok: true, value });
const fail = (code, message, details = {}) => ({ ok: false, error: { code, message, details } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the mock on loopback. `port: 0` picks a free port. `now` pins the instant
 * every fixture time is relative to (default: the moment of the call).
 */
export async function startDemoDsh({ port = 0, now = Date.now() } = {}) {
  const demo = buildDemo(now);
  const pending = { approval: false, plan: false };
  const sockets = { mux: new Set(), host: new Set() };

  const envelope = (payload, rpcId = crypto.randomUUID()) => JSON.stringify({ type: 'server-request', rpcId, method: 'events', payload });
  const broadcastMux = (text) => { for (const s of sockets.mux) s.send(text); };

  const pendingFrames = () => {
    const out = [];
    if (pending.approval) out.push(envelope(demo.approval.payload, demo.approval.rpcId));
    if (pending.plan) out.push(envelope(demo.plan.payload, demo.plan.rpcId));
    return out;
  };

  // What dsh sends on a mux open: a subscribed frame per attached session, the job and
  // projection baselines it holds, then the still-pending approvals and questions.
  const openFrames = () => {
    const out = [];
    for (const [sessionId, history] of demo.histories) {
      out.push(envelope({ type: 'session/subscribed', sessionId, lastSeq: history.length ? history[history.length - 1].event.seq : -1 }));
    }
    for (const [sessionId, list] of Object.entries(demo.jobs)) out.push(envelope({ type: 'session/jobs', sessionId, jobs: list }));
    for (const [sessionId, value] of Object.entries(demo.timing)) {
      out.push(envelope({ type: 'session/projection', sessionId, key: 'subagentTiming', value, seq: 1 }));
    }
    return [...out, ...pendingFrames()];
  };

  const history = (p) => {
    const events = demo.histories.get(p.sessionId);
    if (!demo.sessions.some((s) => s.sessionId === p.sessionId)) return fail('session-not-found', 'session not found', { sessionId: p.sessionId });
    const all = events || [];
    // Every demo log fits in one page, so maxMessages is not needed and an earlier page is empty.
    if (typeof p.beforeSeq === 'number') return ok({ events: [], hasMore: false });
    return ok({ events: all, hasMore: false, projections: demo.historyProjections(p.sessionId) });
  };

  const search = (p) => {
    const q = String(p.query || '').toLowerCase();
    if (!q) return ok({ items: [], hasMore: false });
    const items = [];
    for (const s of demo.sessions) {
      const title = s.projections.values.title;
      const text = (demo.histories.get(s.sessionId) || [])
        .filter((e) => e.event.type === 'user/message' || e.event.type === 'assistant/message')
        .map((e) => (e.event.type === 'user/message' ? e.event.data.content : e.event.data.message.content)
          .filter((b) => b.type === 'text').map((b) => b.text).join(' '));
      const hit = [title, ...text].find((t) => t.toLowerCase().includes(q));
      if (hit) items.push({ sessionId: s.sessionId, snippet: hit.slice(0, 160) });
    }
    return ok({ items: items.slice(0, 20), hasMore: false });
  };

  // method -> (payload) => RpcResult. Typert methods (commands/list, fileReferences/list)
  // carry their arguments under payload.args.
  const METHODS = {
    'host.describe': () => ok(demo.describe),
    'session.list': () => ok({ items: demo.sessions }),
    'workspace.list': () => ok(demo.workspace),
    'session.history': history,
    'session.search': search,
    'session.models': () => ok(demo.models),
    'subagent.list': (p) => ok(demo.subagents[p.parentSessionId] || { entries: [], parentAvailable: false }),
    'session.prompt': () => ok({ accepted: true }),
    'session.cancel': () => ok({ accepted: true }),
    'session.updateQueue': () => ok({ accepted: true }),
    'commands/list': () => ok([]),
    'fileReferences/list': () => ok([]),
  };

  const respond = (body) => {
    // POST /api/respond: the page answers an approval or a question. Answering the
    // demo's pending card clears it, like dsh would, so the page can be clicked through.
    const rpcId = body && body.rpcId;
    if (rpcId === demo.approval.rpcId && pending.approval) {
      pending.approval = false;
      broadcastMux(envelope({ type: 'approval/resolved', sessionId: demo.approval.payload.sessionId, approvalId: demo.approval.payload.approvalId, outcome: 'allowed-once' }));
    } else if (rpcId === demo.plan.rpcId && pending.plan) {
      pending.plan = false;
      broadcastMux(envelope({ type: 'question/resolved', sessionId: demo.plan.payload.sessionId, questionRpcId: demo.plan.rpcId, outcome: 'answered' }));
    }
    return { accepted: true };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/__demo/pending') {
        const body = JSON.parse((await readBody(req)) || '{}');
        for (const k of ['approval', 'plan']) {
          if (typeof body[k] !== 'boolean') continue;
          const was = pending[k];
          pending[k] = body[k];
          if (body[k] && !was) broadcastMux(envelope(demo[k].payload, demo[k].rpcId));
        }
        return json(res, 200, pending);
      }
      if (req.method === 'POST' && url.pathname === '/api/respond') {
        return json(res, 200, respond(JSON.parse((await readBody(req)) || '{}')));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const method = url.pathname.slice('/api/'.length);
        const fn = Object.hasOwn(METHODS, method) ? METHODS[method] : null;
        if (!fn) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
        const payload = body.payload || {};
        const result = fn(method.includes('/') ? (payload.args || {}) : payload);
        return json(res, 200, { type: 'server-response', rpcId: body.rpcId, result });
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request: ' + err.message);
    }
  });

  server.on('upgrade', (req, socket) => {
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); return; }
    const kind = path === '/api/events.mux' ? 'mux' : path === '/api/events.host' ? 'host' : null;
    const key = req.headers['sec-websocket-key'];
    if (!kind || !key) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer = attachSocket(socket, () => sockets[kind].delete(peer));
    sockets[kind].add(peer);
    if (kind === 'mux') for (const text of openFrames()) peer.send(text);
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  return {
    server,
    demo,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    pending,
    setPending(next) {
      for (const k of ['approval', 'plan']) if (typeof next[k] === 'boolean') pending[k] = next[k];
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--now') out.now = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('usage: node scripts/demo-dsh.mjs [--port 3180] [--now <epoch ms>]');
    } else {
      const mock = await startDemoDsh({ port: args.port ?? 3180, now: args.now });
      console.log(`[demo-dsh] demo sessions on ${mock.url} (point dsh-rc at it: node server/index.mjs --dsh-url ${mock.url})`);
      const stop = () => mock.close().finally(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  } catch (err) {
    console.error(`[demo-dsh] ${err.message}`);
    process.exit(2);
  }
}

export { ID };
