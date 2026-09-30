'use strict';
// dsh mobile: a phone-first chat client for a running `dsh web` server.
// Talks to the same-origin /api (HTTP RPC) and /api/events.{mux,host} (WebSockets).

const $ = (s, el = document) => el.querySelector(s);
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
let ridN = 0;
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : `r${Date.now()}-${ridN++}`);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- RPC ----------
async function rpc(method, payload = {}, rpcId = rid()) {
  const r = await fetch('/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  });
  if (!r.ok) throw Object.assign(new Error(`${method}: HTTP ${r.status}`), { code: 'http-' + r.status });
  const j = await r.json();
  if (!j.result || !j.result.ok) {
    const e = j.result && j.result.error || {};
    throw Object.assign(new Error(e.message || `${method} failed`), { code: e.code, details: e.details });
  }
  return j.result.value;
}
const remote = (method, args) => rpc(method, { args });
async function respond(rpcId, result) {
  const r = await fetch('/api/respond', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId, result }),
  });
  if (!r.ok) throw new Error('respond: HTTP ' + r.status);
  const j = await r.json().catch(() => ({}));
  const v = j && (j.result ? j.result.value : j);
  if (v && v.accepted === false) throw new Error('Not accepted: ' + (v.reason || 'unknown'));
  return v;
}

// ---------- State ----------
const S = {
  sessions: [],
  shown: 40,
  parent: new Map(),      // childId -> parentId
  titles: new Map(),      // sessionId -> title
  running: new Map(),     // sessionId -> bool
  approvals: new Map(),   // approvalId -> frame (+rpcId)
  questions: new Map(),   // rpcId -> frame
  queues: new Map(),      // sessionId -> items
  cur: null,
  conn: { mux: null, host: null, up: false, tries: 0, timer: null },
  describe: null,
  steer: false,
  images: [],
  commands: [],
  searchMode: false,
};
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('dshm.titles') || '{}'))) S.titles.set(k, v); } catch {}
function saveTitles() {
  try { localStorage.setItem('dshm.titles', JSON.stringify(Object.fromEntries([...S.titles].slice(-400)))); } catch {}
}
function setTitle(id, t) {
  if (!t || typeof t !== 'string') return;
  if (S.titles.get(id) === t) return;
  S.titles.set(id, t); saveTitles();
  if (S.cur && S.cur.id === id) $('#title').textContent = t;
  if (!$('#listView').hidden && !S.searchMode) renderList();
}
function titleFromProjection(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.title === 'string') return v.title;
  return null;
}

// ---------- Helpers ----------
const home = () => (S.describe && S.describe.home) || '/home/';
function tildify(p) { if (!p) return ''; const hm = home(); return p.startsWith(hm) ? '~' + p.slice(hm.length) : p; }
function basename(p) { if (!p) return ''; const parts = p.replace(/\/+$/, '').split('/'); return parts[parts.length - 1] || p; }
function ago(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function md(text) {
  if (window.marked && window.DOMPurify) {
    try { return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true })); } catch {}
  }
  const d = document.createElement('div'); d.textContent = text;
  return d.innerHTML.replace(/\n/g, '<br>');
}
function linkTargets() {
  if (window.DOMPurify && !linkTargets.done) {
    linkTargets.done = true;
    DOMPurify.addHook('afterSanitizeAttributes', (n) => { if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener'); } });
  }
}
function rootOf(id) { let x = id, n = 0; while (S.parent.has(x) && n++ < 10) x = S.parent.get(x); return x; }
function belongsToCur(id) { return S.cur && (id === S.cur.id || rootOf(id) === S.cur.id); }
function prettyTool(name) {
  if (!name) return 'tool';
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return `${m[1]} · ${m[2]}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
function parseArgs(s) { if (s && typeof s === 'object') return s; try { return JSON.parse(s || '{}'); } catch { return null; } }
function toolSummary(argsStr, view, name) {
  if (view && view.title) {
    const t = String(view.title), n = String(name || '');
    return n && t.toLowerCase().startsWith(n.toLowerCase() + ' ') ? t.slice(n.length + 1) : t;
  }
  const a = parseArgs(argsStr);
  if (!a) return typeof argsStr === 'string' ? argsStr.slice(0, 200) : '';
  const pick = a.command ?? a.cmd ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.description ?? a.prompt;
  if (typeof pick === 'string') return pick.split('\n')[0];
  const first = Object.values(a).find((v) => typeof v === 'string');
  return first ? first.split('\n')[0] : '';
}
function prettyArgs(argsStr) {
  const a = parseArgs(argsStr);
  if (!a) return String(argsStr || '');
  if (typeof a.command === 'string') return a.command;
  if (typeof a.content === 'string' && a.file_path) return `${a.file_path}\n\n${a.content}`;
  return JSON.stringify(a, null, 2);
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);
const textOf = (content) => (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

// ---------- Connection ----------
function setConn(up) {
  S.conn.up = up;
  document.querySelectorAll('.conn').forEach((d) => d.classList.toggle('on', up));
}
function openWS(path, onFrame) {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path);
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m && m.payload) onFrame(m.payload, m); };
  return ws;
}
function connect() {
  const c = S.conn;
  clearTimeout(c.timer);
  for (const k of ['mux', 'host']) if (c[k]) { c[k].onclose = null; try { c[k].close(); } catch {} }
  S.approvals.clear(); S.questions.clear(); renderPending();
  let opened = 0;
  const onOpen = () => {
    if (++opened === 2) {
      c.tries = 0; setConn(true);
      if (S.cur) loadHistory();
    }
  };
  const onClose = () => {
    setConn(false);
    if (c.timer) return;
    const wait = Math.min(10000, 800 * 2 ** c.tries++);
    c.timer = setTimeout(() => { c.timer = null; connect(); }, wait);
  };
  c.mux = openWS('/api/events.mux', onMux);
  c.host = openWS('/api/events.host', onHost);
  for (const ws of [c.mux, c.host]) { ws.onopen = onOpen; ws.onclose = onClose; ws.onerror = () => {}; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const c = S.conn;
  const dead = !c.mux || c.mux.readyState > 1 || !c.host || c.host.readyState > 1;
  if (dead) connect();
  else if (S.cur) loadHistory();
  else if (!$('#listView').hidden) loadSessions();
});

function onMux(p, env) {
  switch (p.type) {
    case 'session/event':
      if (S.cur && p.sessionId === S.cur.id) ingest(p);
      if (p.event && p.event.type === 'session/title') setTitle(p.sessionId, p.event.data && p.event.data.title);
      break;
    case 'session/subscribed':
      if (S.cur && p.sessionId === S.cur.id && !S.cur.loading && p.lastSeq > S.cur.lastSeq) loadHistory();
      break;
    case 'approval/requested':
      S.approvals.set(p.approvalId, { ...p, rpcId: env.rpcId }); renderPending(); badge();
      break;
    case 'approval/resolved':
      S.approvals.delete(p.approvalId); renderPending(); badge();
      break;
    case 'question/requested':
      S.questions.set(env.rpcId, { ...p, rpcId: env.rpcId }); renderPending(); badge();
      break;
    case 'question/resolved':
      S.questions.delete(p.questionRpcId); renderPending(); badge();
      break;
    case 'session/queue':
      S.queues.set(p.sessionId, p.items || []);
      if (S.cur && p.sessionId === S.cur.id) renderQueue();
      break;
    case 'session/projection':
      if (p.key === 'title') setTitle(p.sessionId, titleFromProjection(p.value));
      break;
    case 'stream/error':
      toast('Stream error: ' + (p.error && p.error.message || 'unknown'));
      break;
  }
}
function onHost(p) {
  switch (p.type) {
    case 'host/session-status':
      S.running.set(p.sessionId, !!p.running);
      if (S.cur && p.sessionId === S.cur.id) renderRunning();
      if (!$('#listView').hidden && !S.searchMode) renderList();
      break;
    case 'host/session-added':
      if (p.parentSessionId) S.parent.set(p.sessionId, p.parentSessionId);
      if (!p.blank && !p.parentSessionId && !$('#listView').hidden) loadSessions();
      break;
    case 'host/agent-error':
      if (S.cur && belongsToCur(p.sessionId)) R.note(p.message || 'Agent error', 'err');
      break;
  }
}

// ---------- Sessions list ----------
async function loadSessions() {
  try {
    const v = await rpc('session.list', {});
    const items = v.items || [];
    for (const s of items) {
      if (s.parentSessionId) S.parent.set(s.sessionId, s.parentSessionId);
      S.running.set(s.sessionId, !!s.running);
      const t = s.projections && s.projections.values && titleFromProjection(s.projections.values.title);
      if (t) S.titles.set(s.sessionId, t);
    }
    S.sessions = items.filter((s) => !s.blank && !s.parentSessionId && s.origin !== 'subagent');
    saveTitles();
    if (!S.searchMode) renderList();
    fillTitles();
  } catch (e) {
    $('#sessions').replaceChildren(h('li', { class: 'empty' }, 'Could not load sessions: ' + e.message));
  }
}
let fillingTitles = false;
async function fillTitles() {
  if (fillingTitles) return; fillingTitles = true;
  try {
    const missing = S.sessions.slice(0, Math.min(S.shown, 25)).filter((s) => !S.titles.has(s.sessionId));
    for (const s of missing) {
      try {
        const v = await rpc('session.history', { sessionId: s.sessionId, maxMessages: 1 });
        const t = v.projections && v.projections.values && titleFromProjection(v.projections.values.title);
        if (t) setTitle(s.sessionId, t);
        else {
          const um = (v.events || []).map((x) => x.event).find((e) => e.type === 'user/message' && e.data.source && e.data.source.kind === 'user');
          const txt = um && textOf(um.data.content).trim();
          if (txt) setTitle(s.sessionId, txt.slice(0, 80));
        }
      } catch {}
    }
  } finally { fillingTitles = false; }
}
function pendingCount(sessionId) {
  let n = 0;
  for (const a of S.approvals.values()) if (rootOf(a.sessionId) === sessionId) n++;
  for (const q of S.questions.values()) if (rootOf(q.sessionId) === sessionId) n++;
  return n;
}
function sessRow(s, snippet) {
  const id = s.sessionId;
  const t = S.titles.get(id);
  const running = S.running.get(id);
  const pend = pendingCount(id);
  const meta = [tildify(s.cwd) || '', s.agentPreset || ''].filter(Boolean).join(' · ');
  return h('li', { class: 'sess', onclick: () => openSession(id) },
    h('div', { class: 'main' },
      h('div', { class: 't' + (t ? '' : ' untitled') }, running ? h('span', { class: 'run' }, '● ') : null, t || basename(s.cwd) || 'Untitled', pend ? h('span', { class: 'badge' }, String(pend)) : null),
      snippet ? h('div', { class: 'snip' }, snippet) : h('div', { class: 'm' }, meta)),
    h('div', { class: 'when' }, ago(s.updatedAt)));
}
function renderList() {
  const ul = $('#sessions');
  const rows = S.sessions.slice(0, S.shown).map((s) => sessRow(s));
  ul.replaceChildren(...(rows.length ? rows : [h('li', { class: 'empty' }, 'No sessions yet')]));
  $('#moreBtn').hidden = S.sessions.length <= S.shown;
  badge();
}
function badge() {
  const box = $('#pendingGlobal');
  const n = S.approvals.size + S.questions.size;
  if (!n) { box.replaceChildren(); return; }
  const first = [...S.approvals.values(), ...S.questions.values()][0];
  box.replaceChildren(h('div', { class: 'banner', onclick: () => openSession(rootOf(first.sessionId)) },
    `⚠ ${n} waiting for your answer. Tap to open.`));
}
let searchT = null;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  if (!q) { S.searchMode = false; renderList(); return; }
  searchT = setTimeout(async () => {
    S.searchMode = true;
    try {
      const v = await rpc('session.search', { query: q });
      const byId = new Map(S.sessions.map((s) => [s.sessionId, s]));
      const rows = (v.items || []).map((it) => sessRow(byId.get(it.sessionId) || { sessionId: it.sessionId }, it.snippet));
      $('#sessions').replaceChildren(...(rows.length ? rows : [h('li', { class: 'empty' }, 'No matches')]));
      $('#moreBtn').hidden = true;
    } catch (err) { toast('Search failed: ' + err.message); }
  }, 300);
});
$('#plugBtn').onclick = () => pluginsSheet();
$('#moreBtn').onclick = () => { S.shown += 40; renderList(); fillTitles(); };

// ---------- Renderer ----------
const R = {
  live: new Map(),   // "turn:step" -> {el, blocks: Map(index -> {type, text, el})}
  tools: new Map(),  // callId -> {el, ...}
  fin: new Set(),
  reset() { this.live.clear(); this.tools.clear(); this.fin = new Set(); $('#msgs').replaceChildren(); },
  add(el) { $('#msgs').append(el); return el; },
  note(text, kind = '') { const el = this.add(h('div', { class: 'note ' + kind }, text)); stick(); return el; },

  apply(f) {
    const ev = f.event; if (!ev) return;
    const d = ev.data || {};
    switch (ev.type) {
      case 'user/message': {
        const src = d.source || {};
        if (src.kind !== 'user') return;
        if (src.rpcId) { const p = document.querySelector(`.user.pending[data-rpc="${CSS.escape(src.rpcId)}"]`); if (p) p.remove(); }
        const imgs = (d.content || []).filter((b) => b.type === 'image').length;
        this.add(h('div', { class: 'user' }, textOf(d.content), imgs ? h('div', { class: 'img' }, `🖼 ${imgs} image${imgs > 1 ? 's' : ''}`) : null));
        break;
      }
      case 'assistant/chunk': this.chunk(d); break;
      case 'assistant/message': this.final(d); break;
      case 'tool/call': {
        const t = this.tool(d.callId, d.name, d.arguments);
        if (f.view && f.view.view) { t.view = f.view.view; this.paintTool(t); }
        break;
      }
      case 'tool/result': {
        const m = d.message || {};
        const block = (m.content || []).find((b) => b.type === 'tool-result') || {};
        const callId = (m.source && m.source.callId) || block.toolCallId;
        const t = this.tool(callId);
        t.done = true;
        t.isError = !!block.isError || !!d.error;
        t.result = textOf(block.content) || (d.error && (d.error.message || String(d.error))) || '';
        if (f.view && f.view.view) t.rview = f.view.view;
        this.paintTool(t);
        break;
      }
      case 'turn/end': {
        const r = d.reason || {};
        if (r.kind === 'error') this.note('Error: ' + ((r.error && r.error.message) || 'turn failed'), 'err');
        else if (r.kind === 'aborted' || r.kind === 'interrupted') this.note('Interrupted');
        else if (r.kind === 'max-tokens') this.note('Stopped: output limit reached');
        else if (r.kind === 'blocked') this.note('Turn blocked');
        for (const t of this.tools.values()) if (!t.done) { t.done = true; t.orphan = true; this.paintTool(t); }
        break;
      }
      case 'command/done':
        if (d.text) this.note(d.text, d.kind === 'error' ? 'err' : 'cmd');
        break;
      case 'session/title':
        if (S.cur) setTitle(S.cur.id, d.title);
        break;
      case 'compaction/end':
      case 'compaction/done':
        this.note('Context compacted');
        break;
    }
  },

  key(d) { return `${d.turn}:${d.step}`; },
  liveFor(d) {
    const k = this.key(d);
    let L = this.live.get(k);
    if (!L) { L = { el: this.add(h('div', { class: 'asst' })), blocks: new Map() }; this.live.set(k, L); }
    return L;
  },
  chunk(d) {
    const k = this.key(d);
    if (this.fin.has(k)) return;
    const c = d.chunk || {};
    const L = this.liveFor(d);
    const blk = (idx, type) => {
      let b = L.blocks.get(idx);
      if (!b) {
        b = { type, text: '' };
        if (type === 'reasoning') { b.body = h('div', { class: 'body' }); b.el = h('details', { class: 'think' }, h('summary', {}, 'Thinking…'), b.body); }
        else if (type === 'text') b.el = h('div', { class: 'md' });
        else b.el = h('div');
        L.el.append(b.el); L.blocks.set(idx, b);
      }
      return b;
    };
    switch (c.type) {
      case 'block-start': if (c.blockType !== 'tool-call') blk(c.index, c.blockType); break;
      case 'text-delta': { const b = blk(c.index, 'text'); b.text += c.text || ''; paintSoon(b); break; }
      case 'reasoning-delta': { const b = blk(c.index, 'reasoning'); b.text += c.text || ''; b.body.textContent = b.text; break; }
      case 'tool-call-delta': if (c.id) { const t = this.tool(c.id, c.name, undefined, L.el); if (c.name && !t.name) { t.name = c.name; this.paintTool(t); } } break;
    }
    stick();
  },
  final(d) {
    const k = this.key(d);
    this.fin.add(k);
    const msg = d.message || {};
    const box = h('div', { class: 'asst' });
    for (const b of msg.content || []) {
      if (b.type === 'reasoning' && b.text) box.append(h('details', { class: 'think' }, h('summary', {}, 'Thought'), h('div', { class: 'body' }, b.text)));
      else if (b.type === 'text' && b.text) { const el = h('div', { class: 'md' }); el.innerHTML = md(b.text); box.append(el); }
      else if (b.type === 'tool-call') { const t = this.tool(b.id, b.name, b.arguments, box); box.append(t.el); }
      else if (b.type === 'image') box.append(h('div', { class: 'note' }, '🖼 image'));
    }
    if (d.interrupted) box.append(h('div', { class: 'note' }, 'Interrupted'));
    const L = this.live.get(k);
    if (L) { L.el.replaceWith(box); this.live.delete(k); } else this.add(box);
    stick();
  },
  tool(id, name, args, parent) {
    let t = this.tools.get(id);
    if (!t) {
      t = { id, name, args, el: h('details', { class: 'tool run' }) };
      this.tools.set(id, t);
      (parent || $('#msgs')).append(t.el);
    }
    if (name && !t.name) t.name = name;
    if (args != null && t.args == null) t.args = args;
    this.paintTool(t);
    return t;
  },
  paintTool(t) {
    const cls = t.done ? (t.isError ? 'err' : 'ok') : (t.orphan ? '' : 'run');
    t.el.className = 'tool ' + cls;
    const open = t.el.open;
    const sum = toolSummary(t.args, t.view, t.name);
    const first = (t.result || '').split('\n').find((l) => l.trim()) || '';
    const lines = (t.result || '').split('\n').length;
    const resLine = t.done ? (t.orphan && !t.result ? 'no result' : (first.slice(0, 160) + (lines > 1 ? `  (+${lines - 1} lines)` : ''))) : '';
    const detail = h('div', { class: 'detail' });
    t.el.replaceChildren(
      h('summary', {}, h('span', { class: 'bullet' }, '⏺'), h('span', { class: 'name' }, prettyTool(t.name)), h('span', { class: 'sum' }, sum)),
      t.done && resLine ? h('div', { class: 'res' }, resLine) : null,
      detail);
    // Build detail lazily when opened (keeps long histories fast)
    const fill = () => {
      if (detail.childElementCount) return;
      if (t.args != null) detail.append(h('div', { class: 'lbl' }, 'input'), h('pre', {}, clip(prettyArgs(t.args), 20000)));
      const out = (t.rview && typeof t.rview.output === 'string' && t.rview.output) || t.result;
      if (out) detail.append(h('div', { class: 'lbl' }, t.isError ? 'error' : 'output'), h('pre', {}, clip(out, 20000)));
      if (t.rview && t.rview.exitCode != null) detail.append(h('div', { class: 'lbl' }, 'exit ' + t.rview.exitCode));
    };
    t.el.ontoggle = () => { if (t.el.open) fill(); };
    if (open) { t.el.open = true; fill(); }
  },
};
function paintSoon(b) {
  if (b.raf) return;
  b.raf = requestAnimationFrame(() => { b.raf = 0; b.el.innerHTML = md(b.text); stick(); });
}

// ---------- Scrolling ----------
let pinned = true;
const feed = $('#feed');
feed.addEventListener('scroll', () => {
  pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  $('#jumpBtn').hidden = pinned;
}, { passive: true });
function stick(force) {
  if (!(pinned || force)) return;
  requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}
$('#jumpBtn').onclick = () => { pinned = true; stick(true); };

// ---------- Session view ----------
function sessionMeta(id) { return S.sessions.find((s) => s.sessionId === id) || {}; }
async function openSession(id, { push = true } = {}) {
  if (push && location.hash !== '#s/' + id) history.pushState(null, '', '#s/' + id);
  S.cur = { id, events: [], lastSeq: -1, loading: false, buffer: [], hasMore: false, gen: 0 };
  S.images = []; renderAttachments(); S.steer = false;
  $('#listView').hidden = true; $('#chatView').hidden = false;
  const m = sessionMeta(id);
  $('#title').textContent = S.titles.get(id) || basename(m.cwd) || 'Session';
  $('#subtitle').textContent = [tildify(m.cwd), m.agentPreset].filter(Boolean).join(' · ');
  R.reset(); pinned = true;
  renderRunning(); renderPending(); renderQueue();
  await loadHistory();
  S.commands = [];
  remote('commands/list', { agentId: id }).then((c) => { if (S.cur && S.cur.id === id) S.commands = Array.isArray(c) ? c : []; }).catch(() => {});
}
function showList({ push = true } = {}) {
  if (push && location.hash) history.pushState(null, '', location.pathname);
  S.cur = null;
  $('#chatView').hidden = true; $('#listView').hidden = false;
  loadSessions();
}
window.addEventListener('popstate', route);
function route() {
  const m = /^#s\/(.+)$/.exec(location.hash);
  if (m) openSession(decodeURIComponent(m[1]), { push: false });
  else showList({ push: false });
}
$('#backBtn').onclick = () => showList();

async function loadHistory() {
  const cur = S.cur; if (!cur) return;
  const gen = ++cur.gen;
  cur.loading = true; cur.buffer = [];
  try {
    const v = await rpc('session.history', { sessionId: cur.id, maxMessages: 24 });
    if (S.cur !== cur || gen !== cur.gen) return;
    cur.events = v.events || [];
    cur.hasMore = !!v.hasMore;
    const t = v.projections && v.projections.values && titleFromProjection(v.projections.values.title);
    if (t) setTitle(cur.id, t);
    cur.lastSeq = cur.events.length ? cur.events[cur.events.length - 1].event.seq : -1;
    rerender(true);
  } catch (e) {
    R.note('Could not load history: ' + e.message, 'err');
  } finally {
    if (S.cur === cur && gen === cur.gen) {
      cur.loading = false;
      const buf = cur.buffer; cur.buffer = [];
      for (const f of buf) applyLive(f);
    }
  }
}
function rerender(toBottom) {
  const cur = S.cur;
  R.reset();
  for (const f of cur.events) if (f.event.type === 'assistant/message') R.fin.add(R.key(f.event.data));
  for (const f of cur.events) R.apply(f);
  $('#olderBtn').hidden = !cur.hasMore;
  if (toBottom) { pinned = true; stick(true); }
}
$('#olderBtn').onclick = async () => {
  const cur = S.cur; if (!cur || !cur.events.length) return;
  const btn = $('#olderBtn'); btn.textContent = 'Loading…';
  try {
    const v = await rpc('session.history', { sessionId: cur.id, beforeSeq: cur.events[0].event.seq, maxMessages: 24 });
    if (S.cur !== cur) return;
    const before = feed.scrollHeight;
    cur.events = (v.events || []).concat(cur.events);
    cur.hasMore = !!v.hasMore;
    rerender(false);
    feed.scrollTop = feed.scrollHeight - before;
  } catch (e) { toast('Load failed: ' + e.message); }
  btn.textContent = 'Load earlier';
};
function ingest(frame) {
  const cur = S.cur;
  if (cur.loading) { cur.buffer.push(frame); return; }
  applyLive(frame);
}
function applyLive(frame) {
  const cur = S.cur; const seq = frame.event.seq;
  if (seq <= cur.lastSeq) return;
  if (cur.lastSeq >= 0 && seq > cur.lastSeq + 1) { loadHistory(); return; }
  cur.lastSeq = seq;
  cur.events.push(frame);
  const t = frame.event.type;
  if (t === 'turn/start') S.running.set(cur.id, true);
  R.apply(frame);
  if (t === 'turn/start' || t === 'turn/end') renderRunning();
}

// ---------- Running / queue ----------
let workTimer = null;
function renderRunning() {
  const cur = S.cur; if (!cur) return;
  const running = !!S.running.get(cur.id);
  $('#working').hidden = !running;
  $('#stopBtn').hidden = !running;
  $('#steerBtn').hidden = !running;
  $('#steerBtn').classList.toggle('on', S.steer);
  $('#steerBtn').textContent = S.steer ? 'steer' : 'queue';
  clearInterval(workTimer);
  if (running) {
    const t0 = Date.now();
    const tick = () => { $('#workingText').textContent = `Working… ${Math.floor((Date.now() - t0) / 1000)}s`; };
    tick(); workTimer = setInterval(tick, 1000);
    stick();
  }
}
function renderQueue() {
  const cur = S.cur; if (!cur) return;
  const items = (S.queues.get(cur.id) || []).filter((i) => i.placement !== 'context');
  const el = $('#queueLine');
  el.hidden = !items.length;
  el.textContent = items.length ? `${items.length} message${items.length > 1 ? 's' : ''} queued` : '';
}
$('#stopBtn').onclick = async () => {
  if (!S.cur) return;
  try { await rpc('session.cancel', { sessionId: S.cur.id }); toast('Stopping…'); } catch (e) { toast('Stop failed: ' + e.message); }
};
$('#steerBtn').onclick = () => { S.steer = !S.steer; renderRunning(); };

// ---------- Approvals & questions ----------
function renderPending() {
  const box = $('#pending');
  if (!S.cur) { box.replaceChildren(); return; }
  const cards = [];
  for (const a of S.approvals.values()) if (belongsToCur(a.sessionId)) cards.push(approvalCard(a));
  for (const q of S.questions.values()) if (belongsToCur(q.sessionId)) cards.push(questionCard(q));
  box.replaceChildren(...cards);
  if (cards.length) stick();
}
function approvalCard(a) {
  const t = a.callId && R.tools.get(a.callId);
  const args = t && t.args != null ? prettyArgs(t.args) : '';
  const sub = a.sessionId !== (S.cur && S.cur.id) ? ' (subagent)' : '';
  const card = h('div', { class: 'card approval' },
    h('h4', {}, `Allow ${prettyTool(a.toolName)}?${sub}`),
    a.reason ? h('div', { class: 'why' }, a.reason) : null,
    args ? h('pre', {}, clip(args, 4000)) : null);
  const answer = async (outcome, btn) => {
    card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.textContent = '…';
    try {
      await respond(a.rpcId, { ok: true, value: { sessionId: a.sessionId, approvalId: a.approvalId, outcome } });
      S.approvals.delete(a.approvalId); renderPending(); badge();
    } catch (e) { toast(e.message); card.querySelectorAll('button').forEach((b) => { b.disabled = false; }); btn.textContent = outcome === 'allowed-once' ? 'Allow' : 'Deny'; }
  };
  const no = h('button', { type: 'button' }, 'Deny');
  const yes = h('button', { type: 'button', class: 'yes' }, 'Allow');
  no.onclick = () => answer('rejected', no);
  yes.onclick = () => answer('allowed-once', yes);
  card.append(h('div', { class: 'row' }, no, yes));
  return card;
}
function questionCard(q) {
  const state = (q.questions || []).map((qq) => ({ id: qq.id, selected: new Set(), custom: '' }));
  const card = h('div', { class: 'card' }, h('h4', {}, 'dsh is asking'));
  (q.questions || []).forEach((qq, i) => {
    const st = state[i];
    card.append(h('div', { class: 'q' }, qq.header ? `${qq.header}: ` : '', qq.question));
    if (qq.detail) card.append(h('div', { class: 'why' }, qq.detail));
    const opts = h('div', { class: 'opts' });
    for (const o of qq.options || []) {
      const b = h('button', { type: 'button', class: 'opt' }, o.label, o.description ? h('small', {}, o.description) : null);
      b.onclick = () => {
        if (qq.multiSelect) { st.selected.has(o.label) ? st.selected.delete(o.label) : st.selected.add(o.label); }
        else { st.selected.clear(); st.selected.add(o.label); }
        opts.querySelectorAll('.opt').forEach((x) => x.classList.toggle('sel', st.selected.has(x.firstChild.textContent)));
      };
      opts.append(b);
    }
    card.append(opts);
    const other = h('input', { type: 'text', placeholder: (qq.options || []).length ? 'Other…' : 'Your answer' });
    other.oninput = () => { st.custom = other.value; };
    card.append(other);
  });
  const cancel = h('button', { type: 'button' }, 'Skip');
  const send = h('button', { type: 'button', class: 'yes' }, 'Answer');
  cancel.onclick = async () => {
    try { await respond(q.rpcId, { ok: false, error: { code: 'cancelled', message: 'Skipped from mobile', details: {} } }); S.questions.delete(q.rpcId); renderPending(); } catch (e) { toast(e.message); }
  };
  send.onclick = async () => {
    const answers = state.map((st) => {
      const a = { id: st.id, selected: [...st.selected] };
      if (st.custom.trim()) a.custom = st.custom.trim();
      return a;
    });
    try { await respond(q.rpcId, { ok: true, value: { sessionId: q.sessionId, answer: { answers } } }); S.questions.delete(q.rpcId); renderPending(); } catch (e) { toast(e.message); }
  };
  card.append(h('div', { class: 'row' }, cancel, send));
  return card;
}

// ---------- Composer ----------
const input = $('#input');
function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; }
input.addEventListener('input', () => { grow(); renderCmdPop(); });
input.addEventListener('keydown', (e) => {
  // Desktop convenience: Enter sends, Shift+Enter newline. On touch keyboards Enter inserts a newline.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover: hover)').matches) { e.preventDefault(); send(); }
});
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });

function renderCmdPop() {
  const pop = $('#cmdpop');
  const m = /^\/(\S*)$/.exec(input.value);
  if (!m || !S.commands.length) { pop.hidden = true; return; }
  const q = m[1].toLowerCase();
  const list = S.commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 12);
  if (!list.length) { pop.hidden = true; return; }
  pop.replaceChildren(...list.map((c) => h('button', { type: 'button', class: 'cmd', onclick: () => { input.value = '/' + c.name + ' '; pop.hidden = true; input.focus(); grow(); } },
    h('b', {}, '/' + c.name), c.description ? h('span', {}, c.description) : null)));
  pop.hidden = false;
}

async function send() {
  const cur = S.cur; if (!cur) return;
  const text = input.value.trim();
  const images = S.images.slice();
  if (!text && !images.length) return;
  $('#cmdpop').hidden = true;
  if (/^\/\S/.test(text)) {
    input.value = ''; grow();
    try {
      const r = await remote('commands/execute', { agentId: cur.id, line: text, images: images.map(({ mediaType, data, name }) => ({ mediaType, data, name })) });
      S.images = []; renderAttachments();
      if (!r) R.note(`Unknown command: ${text.split(/\s/)[0]}`, 'err');
      else if (r.result && r.result.text) R.note(r.result.text, r.result.kind === 'error' ? 'err' : 'cmd');
      else R.note(`${text.split(/\s/)[0]} done`);
    } catch (e) { R.note(`Command failed: ${e.message}`, 'err'); input.value = text; }
    return;
  }
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const im of images) content.push({ type: 'image', mediaType: im.mediaType, data: im.data, name: im.name });
  const rpcId = rid();
  const bubble = R.add(h('div', { class: 'user pending', 'data-rpc': rpcId }, text, images.length ? h('div', { class: 'img' }, `🖼 ${images.length}`) : null));
  pinned = true; stick(true);
  input.value = ''; grow(); S.images = []; renderAttachments();
  const payload = { sessionId: cur.id, mode: S.steer && S.running.get(cur.id) ? 'steer' : 'queue', content };
  if (TZ) payload.clientTimeZone = TZ;
  try {
    await rpc('session.prompt', payload, rpcId);
    S.steer = false; renderRunning();
  } catch (e) {
    bubble.remove();
    input.value = text; grow();
    S.images = images; renderAttachments();
    toast('Send failed: ' + e.message, 4000);
  }
}

// Images
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    try { S.images.push(await toImage(f)); } catch (err) { toast('Image failed: ' + err.message); }
  }
  e.target.value = '';
  renderAttachments();
});
async function toImage(file) {
  // Downscale large photos to keep uploads fast over mobile data. Output JPEG unless PNG/GIF/WEBP small enough.
  const okTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (okTypes.includes(file.type) && file.size < 1.5e6) return { mediaType: file.type, data: await b64(file), name: file.name, url: URL.createObjectURL(file) };
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return { mediaType: 'image/jpeg', data: await b64(blob), name: (file.name || 'image').replace(/\.\w+$/, '') + '.jpg', url: URL.createObjectURL(blob) };
}
function b64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
}
function renderAttachments() {
  const box = $('#attachments');
  box.hidden = !S.images.length;
  box.replaceChildren(...S.images.map((im, i) => h('div', { class: 'thumb' }, h('img', { src: im.url, alt: '' }),
    h('button', { type: 'button', onclick: () => { S.images.splice(i, 1); renderAttachments(); } }, '×'))));
}

// ---------- Sheets ----------
function openSheet(...kids) {
  $('#sheetBody').replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  $('#sheet').scrollTop = 0;
  $('#scrim').hidden = false; $('#sheet').hidden = false;
}
function closeSheet() { $('#scrim').hidden = true; $('#sheet').hidden = true; }
$('#scrim').addEventListener('click', closeSheet);
$('#sheetClose').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
// Swipe down on the sheet (when scrolled to top) to dismiss.
(() => {
  const sheet = $('#sheet'); let y0 = null, dy = 0;
  sheet.addEventListener('touchstart', (e) => { y0 = sheet.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    sheet.style.transform = '';
    if (y0 != null && dy > 90) closeSheet();
    y0 = null; dy = 0;
  });
})();

// Folder choices: saved workspaces plus project roots from recent sessions.
// Sessions in deep work dirs (agent-queue/work/…) collapse to their top folder under home;
// temp and scratchpad folders are skipped.
function folderChoices(workspaces) {
  const hm = home().replace(/\/$/, '');
  const roots = new Map();
  const add = (p, name, t) => {
    if (!p) return;
    const r = roots.get(p);
    if (!r) roots.set(p, { path: p, name: name || (p === hm ? 'Home' : basename(p)), t: t || 0 });
    else r.t = Math.max(r.t, t || 0);
  };
  for (const w of workspaces || []) add(w.path, w.title, w.updatedAt);
  for (const s of S.sessions) {
    const p = s.cwd;
    if (!p || p.startsWith('/tmp') || p.includes('/scratchpad')) continue;
    let root = p;
    if (p.startsWith(hm + '/')) root = hm + '/' + p.slice(hm.length + 1).split('/')[0];
    add(root, null, s.updatedAt);
  }
  return [...roots.values()].sort((a, b) => b.t - a.t).slice(0, 10);
}
const untilde = (p) => (p.startsWith('~') ? home().replace(/\/$/, '') + p.slice(1) : p);

$('#newBtn').onclick = async () => {
  const path = h('input', { type: 'text', class: 'mono', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'folders' });
  const preset = h('select', {});
  const go = h('button', { type: 'button', class: 'go' }, 'Start session');
  let touched = false;
  path.addEventListener('input', () => { touched = true; });
  const select = (p, byUser) => {
    if (byUser) touched = true;
    path.value = tildify(p);
    list.querySelectorAll('.folder').forEach((b) => b.classList.toggle('sel', b.dataset.path === p));
  };
  const showChoices = (choices) => {
    list.replaceChildren(
      ...choices.map((c) => h('button', { type: 'button', class: 'folder', 'data-path': c.path, onclick: () => select(c.path, true) },
        h('b', {}, c.name), h('small', {}, tildify(c.path)))),
      h('button', { type: 'button', class: 'folder browse', onclick: () => browse(untilde(path.value.trim()) || home()) }, h('b', {}, 'Browse folders…')));
  };
  const browse = async (dir) => {
    touched = true;
    try {
      const v = await rpc('host.listDirectory', { path: dir });
      path.value = tildify(v.path);
      const up = v.path.replace(/\/[^/]+\/?$/, '') || '/';
      list.replaceChildren(
        h('div', { class: 'crumb' }, tildify(v.path)),
        h('button', { type: 'button', class: 'folder', onclick: () => browse(up) }, h('b', {}, '‹ Up')),
        ...(v.entries || []).filter((e) => !e.hidden).map((e) => h('button', { type: 'button', class: 'folder', onclick: () => browse(e.path) }, h('b', {}, e.name + '/'))),
        v.truncated ? h('div', { class: 'note' }, 'List truncated') : null,
        h('button', { type: 'button', class: 'folder browse', onclick: () => showChoices(choices) }, h('b', {}, 'Back to recent folders')));
    } catch (e) { toast('Cannot open folder: ' + e.message); }
  };
  openSheet(h('h3', {}, 'New session'),
    h('label', {}, 'Folder'), path, list,
    h('label', {}, 'Agent preset'), preset, go);
  let choices = folderChoices([]);
  showChoices(choices); if (choices[0]) select(choices[0].path);
  rpc('workspace.list', {}).then((v) => {
    choices = folderChoices(v.items || []);
    if (!list.querySelector('.crumb') && !touched) { showChoices(choices); if (choices[0]) select(choices[0].path); }
  }).catch(() => {});
  try {
    const v = await rpc('agentPreset.list', {});
    for (const p of v.presets || []) if (!p.broken) preset.append(h('option', { value: p.id, selected: p.isDefault }, (p.name || p.id) + (p.isDefault ? ' (default)' : '')));
  } catch { preset.append(h('option', { value: '' }, 'default')); }
  go.onclick = async () => {
    const p = untilde(path.value.trim());
    go.disabled = true; go.textContent = 'Starting…';
    try {
      const payload = {};
      if (p) payload.cwd = p;
      if (preset.value) payload.agentPreset = preset.value;
      const r = await rpc('session.create', payload);
      closeSheet();
      S.sessions.unshift({ sessionId: r.sessionId, cwd: p, agentPreset: r.agentPreset || preset.value, updatedAt: Date.now() });
      openSession(r.sessionId);
      setTimeout(() => input.focus(), 150);
    } catch (e) { toast('Could not start: ' + e.message, 4000); go.disabled = false; go.textContent = 'Start session'; }
  };
};

$('#menuBtn').onclick = () => {
  const cur = S.cur; if (!cur) return;
  openSheet(h('h3', {}, $('#title').textContent),
    h('button', { class: 'menuitem', onclick: modelSheet }, 'Model', h('small', {}, 'Switch the model for this session')),
    h('button', { class: 'menuitem', onclick: commandsSheet }, 'Commands', h('small', {}, 'Slash commands available here')),
    h('button', { class: 'menuitem', onclick: renameSheet }, 'Rename'),
    h('button', { class: 'menuitem', onclick: pluginsSheet }, 'Plugins & connectors', h('small', {}, 'What this dsh has loaded')),
    h('button', { class: 'menuitem', onclick: () => { closeSheet(); loadHistory(); } }, 'Refresh'),
    h('a', { class: 'menuitem', href: '/', style: 'color:inherit;text-decoration:none' }, 'Open full dsh web UI'));
};
// ---------- Plugins (read-only) ----------
// dsh exposes only a read-only inventory; adding or toggling plugins is a laptop-side change.
async function pluginsSheet() {
  openSheet(h('h3', {}, 'Plugins & connectors'), h('div', { class: 'note' }, 'Loading…'));
  let entries;
  try {
    const v = await remote('pluginInventory/list', {});
    entries = (v && (v.entries || v.items)) || (Array.isArray(v) ? v : []);
  } catch (e) { openSheet(h('h3', {}, 'Plugins & connectors'), h('div', { class: 'note err' }, 'Could not read the plugin list: ' + e.message)); return; }
  const phase = (e) => e.fiberPhase ?? e.phase ?? null;
  const shortId = (e) => String(e.entryId || '').split(':').pop();
  const state = (e) => !e.enabled ? 'off' : (phase(e) === 'failed' ? 'failed' : (phase(e) && phase(e) !== 'active' ? phase(e) : 'on'));
  const row = (e, label) => {
    const st = state(e);
    return h('div', { class: 'plug' },
      h('span', { class: 'pdot ' + st }),
      h('div', { class: 'pmain' }, h('b', {}, label || shortId(e)), h('small', {}, e.moduleName || '')),
      h('span', { class: 'pstate ' + st }, st));
  };
  const mcp = entries.filter((e) => /dsh-mcp-client/.test(e.moduleName || ''));
  const subs = entries.filter((e) => /dsh-subagent-(claude-code|codex|acp|dsh-sdk)/.test(e.moduleName || '') && !/tool-/.test(e.entryId));
  const bad = entries.filter((e) => e.enabled && (phase(e) === 'failed'));
  const all = entries.filter((e) => e.moduleName && !/^cordis:/.test(e.moduleName));
  const list = h('div', { class: 'plist' });
  const search = h('input', { type: 'search', placeholder: `Search ${all.length} plugins`, autocomplete: 'off' });
  const renderAll = () => {
    const q = search.value.trim().toLowerCase();
    const hits = all.filter((e) => !q || (e.entryId + ' ' + e.moduleName).toLowerCase().includes(q));
    list.replaceChildren(...hits.slice(0, 200).map((e) => row(e)));
  };
  search.oninput = renderAll;
  const section = (title, items, label) => items.length ? [h('div', { class: 'grp' }, title), ...items.map((e) => row(e, label && label(e)))] : [];
  openSheet(
    h('h3', {}, 'Plugins & connectors'),
    bad.length ? h('div', { class: 'note err' }, `${bad.length} plugin${bad.length > 1 ? 's' : ''} failed to load.`) : null,
    ...section('Failed', bad),
    ...section('Connectors (MCP)', mcp, (e) => shortId(e).replace(/^mcp-/, '')),
    ...section('Subagent providers', subs, (e) => shortId(e).replace(/^subagent-/, '')),
    h('div', { class: 'grp' }, 'All plugins'), search, list,
    h('div', { class: 'note' }, 'Read-only. Plugins and connectors are added on the laptop in the dsh profile, then dsh restarts.'));
  renderAll();
}

async function modelSheet() {
  const cur = S.cur;
  openSheet(h('h3', {}, 'Model'), h('div', { class: 'note' }, 'Loading…'));
  try {
    const v = await rpc('session.models', { sessionId: cur.id });
    const c = v.current || {};
    const kids = [h('h3', {}, 'Model')];
    for (const g of v.groups || []) {
      kids.push(h('div', { class: 'grp' }, g.name || g.id));
      for (const m of g.models || []) {
        const isCur = c.provider === g.id && c.model === m.id;
        kids.push(h('button', { class: 'menuitem' + (isCur ? ' cur' : ''), onclick: async () => {
          try {
            const payload = { sessionId: cur.id, provider: g.id, model: m.id };
            if (m.reasoning && m.reasoning.defaultEffort) payload.reasoningEffort = m.reasoning.defaultEffort;
            await rpc('session.selectModel', payload);
            toast('Model: ' + (m.name || m.id)); closeSheet();
          } catch (e) { toast('Switch failed: ' + e.message, 4000); }
        } }, (isCur ? '✓ ' : '') + (m.name || m.id), m.description ? h('small', {}, m.description) : null));
      }
    }
    openSheet(...kids);
  } catch (e) { openSheet(h('h3', {}, 'Model'), h('div', { class: 'note err' }, e.message)); }
}
function commandsSheet() {
  const list = S.commands || [];
  openSheet(h('h3', {}, 'Commands'), ...(list.length ? list.map((c) => h('button', { class: 'menuitem', onclick: () => { closeSheet(); input.value = '/' + c.name + ' '; grow(); input.focus(); } },
    '/' + c.name, c.description ? h('small', {}, c.description) : null)) : [h('div', { class: 'note' }, 'No commands reported')]));
}
function renameSheet() {
  const cur = S.cur;
  const inp = h('input', { type: 'text', value: S.titles.get(cur.id) || '' });
  const go = h('button', { type: 'button', class: 'go' }, 'Save');
  go.onclick = async () => {
    try { const r = await rpc('session.rename', { sessionId: cur.id, title: inp.value.trim() }); setTitle(cur.id, r.title || inp.value.trim()); closeSheet(); }
    catch (e) { toast('Rename failed: ' + e.message); }
  };
  openSheet(h('h3', {}, 'Rename'), inp, go);
  setTimeout(() => inp.focus(), 100);
}

// ---------- Viewport (iOS keyboard) ----------
function fitViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty('--vvh', (vv ? vv.height : window.innerHeight) + 'px');
  if (vv) window.scrollTo(0, 0);
}
if (window.visualViewport) { visualViewport.addEventListener('resize', () => { fitViewport(); stick(); }); }
window.addEventListener('resize', fitViewport);
fitViewport();

// ---------- Boot ----------
(async function boot() {
  linkTargets();
  window.addEventListener('load', linkTargets);
  try { S.describe = await rpc('host.describe', {}); } catch (e) { toast('dsh not reachable: ' + e.message, 6000); }
  connect();
  await loadSessions();
  if (location.hash) route();
})();
