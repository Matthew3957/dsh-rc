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

/* ---------- API errors ---------- */
let api403Shown = false;
function copyText(text, btn) {
  // Keep the original label once: a quick double tap would otherwise capture "Copied" and restore to it.
  const restore = btn.dataset.label || (btn.dataset.label = btn.textContent);
  const done = () => {
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = restore; }, 1400);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    let success = false;
    try { success = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    if (success) done(); else toast('Copy failed');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
// dsh 0.2 replaced the HTTP RPC surface this page speaks (methods like session.list are gone) and
// wants a launch-token cookie, so nothing here can work against it. Say so instead of failing piecemeal.
// 401 from dsh itself (not dsh-rc's login) is dsh 0.2's token gate. A 404 is ambiguous: dsh 0.2
// renamed every method, but a /api that is not routed to dsh at all answers 404 too.
function showUnsupportedDsh(code) {
  const four04 = code === 'http-404';
  const card = h('div', { class: 'card api403' },
    h('h4', {}, four04 ? 'dsh-rc cannot find dsh here' : 'This dsh is too new for dsh-rc'),
    h('div', { class: 'why' }, four04
      ? 'host.describe answered 404. Either this page\'s /api is not reaching dsh (check the Tailscale Serve mount, ' +
        'or --dsh-url when dsh-rc runs as the front door), or dsh is 0.2, which dsh-rc does not support yet ' +
        '(tested on 0.1.1-rc.2; see Compatibility in the README).'
      : 'dsh answered 401 to host.describe, which is how dsh 0.2 behaves. dsh-rc speaks the dsh 0.1 API ' +
        '(tested on 0.1.1-rc.2). Run dsh 0.1.x for now; see Compatibility in the README.'));
  $('#api403').replaceChildren(card);
}
// trusted: the name dsh-rc's proxy says dsh must trust; absent when the page sits beside dsh.
function showApi403(trusted) {
  if (api403Shown) return;
  api403Shown = true;
  const host = trusted || location.hostname;
  const cmd = 'dsh --profile <profile> --no-open --trusted-host ' + host;
  const close = h('button', { type: 'button', class: 'close', 'aria-label': 'Dismiss' }, '✕');
  close.onclick = () => $('#api403').replaceChildren();
  const copy = h('button', { type: 'button', class: 'copy' }, 'Copy command');
  copy.onclick = () => copyText(cmd, copy);
  const card = h('div', { class: 'card api403' },
    close,
    h('h4', {}, '403 — dsh does not trust this host'),
    h('div', { class: 'why' },
      trusted
        ? 'dsh does not trust the name dsh-rc\'s proxy presents. Start dsh with --trusted-host ' + host + '.'
        : 'This page reached dsh from a host it does not trust. Start dsh with --trusted-host ' + host + ' (the current hostname, filled in below) ' +
          'and make sure this page is served from the same origin as dsh web.'),
    h('pre', {}, cmd),
    h('div', { class: 'row' }, copy));
  $('#api403').replaceChildren(card);
  // The card lives in the session list; if a session is open, point there instead of failing silently.
  if (S.cur) toast('dsh answered 403: it does not trust this host. Go back to the session list for the fix.', 8000);
}

// ---------- RPC ----------
// dsh-rc's own server answers 401 once a login has expired and marks it with X-Dsh-Rc-Login.
// dsh 0.1 never answers 401; dsh 0.2 does when it has no browser cookie, which is no login problem.
// Relative, so it also works when the page is mounted under a path.
// Returns true when dsh-rc's own login expired; callers then throw code 'login' so boot
// does not mistake it for a dsh that answers 401 (dsh 0.2).
function checkLogin(r) {
  if (r.status === 401 && r.headers.get('x-dsh-rc-login')) { location.assign('login'); return true; }
  return false;
}
async function rpc(method, payload = {}, rpcId = rid()) {
  const r = await fetch('/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  });
  if (checkLogin(r)) throw Object.assign(new Error('login required'), { code: 'login' });
  if (!r.ok) {
    if (r.status === 403) showApi403(r.headers.get('x-dsh-rc-trusted-host'));
    throw Object.assign(new Error(`${method}: HTTP ${r.status}`), { code: 'http-' + r.status });
  }
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
  if (checkLogin(r)) throw Object.assign(new Error('login required'), { code: 'login' });
  if (!r.ok) throw new Error('respond: HTTP ' + r.status);
  const j = await r.json().catch(() => ({}));
  const v = j && (j.result ? j.result.value : j);
  if (v && v.accepted === false) throw new Error('Not accepted: ' + (v.reason || 'unknown'));
  return v;
}

// ---------- State ----------
const S = {
  sessions: [],
  archived: new Set(),    // ids hidden from the list (workspace.archiveSession)
  shown: 40,
  parent: new Map(),      // childId -> parentId
  titles: new Map(),      // sessionId -> title
  running: new Map(),     // sessionId -> bool
  turnStart: new Map(),   // sessionId -> time of the running turn's turn/start, when seen live
  approvals: new Map(),   // approvalId -> frame (+rpcId)
  questions: new Map(),   // rpcId -> frame
  queues: new Map(),      // sessionId -> items
  projections: new Map(), // sessionId -> Map(key -> {seq, value})
  jobs: new Map(),        // sessionId -> JobView[] (the session/jobs snapshot)
  subagents: new Map(),   // parentId -> {entries, parentAvailable, at}
  agentsLoading: new Set(), // parentIds whose subagent.list call is in flight
  dashOpen: new Set(),    // sessionIds whose dashboard card is expanded
  dashCollapsed: true,    // Running now is one quiet line until tapped open
  model: new Map(),       // sessionId -> {provider, model} in use
  prices: null,           // price overrides, read from localStorage once
  cur: null,
  conn: { mux: null, host: null, up: false, tries: 0, timer: null },
  describe: null,
  steer: false,
  images: [],
  commands: [],
  searchMode: false,
  filter: 'all',          // session list filter: all | running | waiting
  tunnelUrl: null,        // set when dsh-rc runs with --tunnel
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
// dsh keeps one value per projection per session: pushed live by
// `session/projection` frames and seeded from the history tail page's block.
// Frames carry a watermark, so a stale frame arriving after a fresher value is
// dropped (higher seq wins) instead of regressing the store. A history seed
// counts as -1, since the block carries no watermark of its own.
function setProjection(sessionId, key, value, seq) {
  let box = S.projections.get(sessionId);
  if (!box) { box = new Map(); S.projections.set(sessionId, box); }
  const prev = box.get(key);
  if (prev && seq <= prev.seq) return false;
  box.set(key, { seq, value });
  return true;
}
function projectionValue(sessionId, key) {
  const box = S.projections.get(sessionId);
  const hit = box && box.get(key);
  return hit ? hit.value : undefined;
}
// A `session.list` row carries a projection baseline for every attached session.
// It may lag a live push, so it only fills a key no live frame has set yet.
function seedProjection(sessionId, key, value) {
  let box = S.projections.get(sessionId);
  if (!box) { box = new Map(); S.projections.set(sessionId, box); }
  const prev = box.get(key);
  if (prev && prev.seq >= 0) return false;
  box.set(key, { seq: -1, value });
  return true;
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
// Elapsed working time for the dashboard. Unlike ago(), this counts up and keeps
// seconds, because a turn that has run for two minutes should not read "2m" and
// then appear stuck.
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor((typeof ms === 'number' && Number.isFinite(ms) ? ms : 0) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return hrs + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  return Math.floor(hrs / 24) + 'd ' + String(hrs % 24).padStart(2, '0') + 'h';
}
function md(text) {
  if (window.marked && window.DOMPurify) {
    try { return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true })); } catch {}
  }
  const d = document.createElement('div'); d.textContent = text;
  return d.innerHTML.replace(/\n/g, '<br>');
}
// The same markdown as nodes rather than an HTML string, so a caller appends it
// and never assigns innerHTML. Without the vendored libraries it is plain text.
function mdNode(text) {
  if (window.marked && window.DOMPurify) {
    try { return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), { RETURN_DOM_FRAGMENT: true }); } catch {}
  }
  return h('div', { class: 'plain' }, text);
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
// dsh's own token formatting, so the status line reads like the web UI.
function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (n < 1e3) return String(n);
  if (n < 1e6) return scaled(n / 1e3) + 'K';
  return scaled(n / 1e6) + 'M';
}
// Estimates run to a fraction of a cent, so precision follows magnitude: a
// $0.12 session should not read "est. $0.12" and a $0.0004 one not "est. $0.00".
function fmtUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n === 0) return '$0';
  if (n < 0.0001) return '<$0.0001';
  if (n < 1) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

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

// A session created by another client starts blank, so `host/session-added` does
// not reload the list. Its first turn/start is the moment it becomes a real row;
// pull the list once then (throttled) so the dashboard and the list both see it.
let sessionsReload = null;
let sessionsReloadAt = 0;
function sessionKnown(id) { return S.parent.has(id) || (S.sessions || []).some((s) => s.sessionId === id); }
function scheduleSessionsReload() {
  if (sessionsReload) return;
  const wait = Math.max(0, 1500 - (Date.now() - sessionsReloadAt));
  sessionsReload = setTimeout(() => {
    sessionsReload = null;
    sessionsReloadAt = Date.now();
    if (!$('#listView').hidden) loadSessions();
  }, wait);
  if (sessionsReload && sessionsReload.unref) sessionsReload.unref();
}

function onMux(p, env) {
  switch (p.type) {
    case 'session/event': {
      const ev = p.event;
      if (ev) {
        // Track the running turn for every session, not only the open one: the
        // dashboard shows sessions whose events the chat view never ingests.
        if (ev.type === 'turn/start') {
          S.running.set(p.sessionId, true);
          if (typeof ev.time === 'number') S.turnStart.set(p.sessionId, ev.time);
          if (!sessionKnown(p.sessionId)) scheduleSessionsReload();
        } else if (ev.type === 'turn/end') { S.running.set(p.sessionId, false); S.turnStart.delete(p.sessionId); }
      }
      if (S.cur && p.sessionId === S.cur.id) ingest(p);
      if (ev && ev.type === 'session/title') setTitle(p.sessionId, ev.data && ev.data.title);
      if (ev && (ev.type === 'turn/start' || ev.type === 'turn/end')) scheduleDashboard();
      break;
    }
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
      S.questions.delete(p.questionRpcId); planDrafts.delete(p.questionRpcId); renderPending(); badge();
      break;
    case 'session/queue':
      S.queues.set(p.sessionId, p.items || []);
      if (S.cur && p.sessionId === S.cur.id) renderQueue();
      break;
    case 'session/jobs':
      // The frame is the complete set for one session; an emptied set still
      // arrives as [] because absence cannot express "just finished".
      if (Array.isArray(p.jobs) && p.jobs.length) S.jobs.set(p.sessionId, p.jobs);
      else S.jobs.delete(p.sessionId);
      scheduleDashboard();
      break;
    case 'session/projection': {
      if (p.key === 'title') setTitle(p.sessionId, titleFromProjection(p.value));
      const seq = typeof p.seq === 'number' ? p.seq : -1;
      if (setProjection(p.sessionId, p.key, p.value, seq)) {
        if (S.cur && p.sessionId === S.cur.id) renderStatusLine();
        if (DASH_KEYS.has(p.key)) scheduleDashboard();
      }
      break;
    }
    case 'stream/error':
      toast('Stream error: ' + (p.error && p.error.message || 'unknown'));
      break;
  }
}
function onHost(p) {
  switch (p.type) {
    case 'host/session-status':
      if (p.running && !S.running.get(p.sessionId)) S.turnStart.set(p.sessionId, Date.now());
      if (!p.running) S.turnStart.delete(p.sessionId);
      S.running.set(p.sessionId, !!p.running);
      if (S.cur && p.sessionId === S.cur.id) renderRunning();
      if (!$('#listView').hidden && !S.searchMode) renderList();
      scheduleDashboard();
      break;
    case 'host/session-added':
      // Only subagents fold into their parent. A fork also carries parentSessionId (lineage), but it
      // is a session of its own and belongs in the list.
      if (p.parentSessionId && p.origin === 'subagent') S.parent.set(p.sessionId, p.parentSessionId);
      if (!p.blank && p.origin !== 'subagent' && !$('#listView').hidden) loadSessions();
      scheduleDashboard();
      break;
    case 'host/session-removed':
      S.jobs.delete(p.sessionId); S.subagents.delete(p.sessionId); S.dashOpen.delete(p.sessionId);
      scheduleDashboard();
      break;
    case 'host/archived-sessions-changed':
      if (!window.dshActions) break; // session-actions.js failed to load: keep the list as it is
      S.archived = window.dshActions.archiveSet(p.archivedSessionIds);
      S.sessions = window.dshActions.visibleSessions(S.sessions, S.archived);
      if (!$('#listView').hidden && !S.searchMode) renderList();
      scheduleDashboard();
      break;
    case 'host/agent-error':
      if (S.cur && belongsToCur(p.sessionId)) R.note(p.message || 'Agent error', 'err');
      break;
  }
}

// ---------- Sessions list ----------
async function loadSessions() {
  try {
    // workspace.list carries the archive set; session.list keeps returning archived rows.
    const [v, ws] = await Promise.all([rpc('session.list', {}), rpc('workspace.list', {}).catch(() => null)]);
    const acts = window.dshActions; // guarded like dshPrices and dshReview: a missing module must not blank the list
    // dsh cannot unarchive, so the set only grows: merging means an older, slower answer
    // can never bring back a session archived after it was sent.
    if (acts && ws && ws.archivedSessionIds) S.archived = new Set([...(S.archived || []), ...acts.archiveSet(ws.archivedSessionIds)]);
    const items = v.items || [];
    for (const s of items) {
      if (s.parentSessionId && s.origin === 'subagent') S.parent.set(s.sessionId, s.parentSessionId);
      S.running.set(s.sessionId, !!s.running);
      if (!s.running) S.turnStart.delete(s.sessionId);
      const values = s.projections && s.projections.values;
      if (values) for (const [key, value] of Object.entries(values)) seedProjection(s.sessionId, key, value);
      const t = values && titleFromProjection(values.title);
      if (t) S.titles.set(s.sessionId, t);
    }
    const listed = items.filter((s) => !s.blank && s.origin !== 'subagent');
    S.sessions = acts ? acts.visibleSessions(listed, S.archived) : listed;
    saveTitles();
    if (!S.searchMode) renderList();
    renderDashboard();
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
function sessState(id) {
  if (pendingCount(id)) return 'wait';
  return sessionIsWorking(id) ? 'run' : 'idle';
}
// One row: a status glyph, the title, and one muted line (state, age, folder).
function sessRow(s, snippet) {
  const id = s.sessionId;
  const t = S.titles.get(id);
  const state = sessState(id);
  const pend = pendingCount(id);
  const folder = basename(s.cwd);
  const when = ago(s.updatedAt);
  const sub = state === 'wait' ? [pend > 1 ? `${pend} waiting for you` : 'Waiting for you', when, folder]
    : state === 'run' ? ['Working', folder] : [when, folder];
  return h('li', { class: 'sess ' + state, onclick: () => openSession(id) },
    h('span', { class: 'glyph ' + state, 'aria-hidden': 'true' }),
    h('div', { class: 'main' },
      h('div', { class: 't' + (t ? '' : ' untitled') }, t || folder || 'Untitled'),
      snippet ? h('div', { class: 'snip' }, snippet) : h('div', { class: 'm' }, sub.filter(Boolean).join(' · '))));
}
const FILTERS = { all: 'All sessions', running: 'Running', waiting: 'Waiting for you' };
function filteredSessions() {
  if (S.filter === 'all') return S.sessions;
  const want = S.filter === 'running' ? 'run' : 'wait';
  return S.sessions.filter((s) => sessState(s.sessionId) === want);
}
function renderList() {
  const ul = $('#sessions');
  const all = filteredSessions();
  const rows = all.slice(0, S.shown).map((s) => sessRow(s));
  const none = S.filter === 'all' ? 'No sessions yet' : (S.filter === 'running' ? 'Nothing is running' : 'Nothing is waiting for you');
  ul.replaceChildren(...(rows.length ? rows : [h('li', { class: 'empty' }, none)]));
  $('#moreBtn').hidden = all.length <= S.shown;
  $('#filterBtn').classList.toggle('active', S.filter !== 'all');
  paintBanner();
}
// Approvals and questions change a row's glyph as well as the banner.
function badge() {
  if (!$('#listView').hidden && !S.searchMode) renderList(); else paintBanner();
}
function paintBanner() {
  const box = $('#pendingGlobal');
  const n = S.approvals.size + S.questions.size;
  if (!n) { box.replaceChildren(); return; }
  const first = [...S.approvals.values(), ...S.questions.values()][0];
  box.replaceChildren(h('button', { class: 'banner', type: 'button', onclick: () => openSession(rootOf(first.sessionId)) },
    h('span', { class: 'glyph wait', 'aria-hidden': 'true' }), `${n} waiting for your answer`));
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
// Search lives in the floating strip: the round button opens it, the close button puts it away.
function openSearch() {
  $('#dockActions').hidden = true; $('#searchRow').hidden = false;
  $('#q').focus();
}
function closeSearch() {
  clearTimeout(searchT);
  $('#q').value = '';
  $('#searchRow').hidden = true; $('#dockActions').hidden = false;
  if (S.searchMode) { S.searchMode = false; renderList(); }
}
$('#searchBtn').onclick = openSearch;
$('#searchClose').onclick = closeSearch;
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
function listMenuSheet() {
  const notifState = h('small', {}, 'Approvals, questions, finished turns');
  refreshPushState().then((st) => { notifState.textContent = pushStateLabel(st); }).catch(() => {});
  openSheet(h('h3', {}, 'Menu'),
    h('button', { class: 'menuitem', onclick: () => notificationsSheet() }, 'Notifications', notifState),
    h('button', { class: 'menuitem', onclick: pluginsSheet }, 'Plugins & connectors', h('small', {}, 'What this dsh has loaded')),
    S.tunnelUrl ? h('button', { class: 'menuitem', onclick: () => { tunnelSheet().catch((e) => toast('Tunnel address unavailable: ' + e.message)); } }, 'Open on your phone', h('small', {}, 'Show the tunnel address as a QR code')) : null,
    location.pathname.replace(/\/+$/, '') ? h('a', { class: 'menuitem', href: '/', style: 'color:inherit;text-decoration:none' }, 'Open full dsh web UI') : null);
}
function filterSheet() {
  const count = (want) => S.sessions.filter((s) => sessState(s.sessionId) === want).length;
  const n = { all: S.sessions.length, running: count('run'), waiting: count('wait') };
  openSheet(h('h3', {}, 'Show'),
    ...Object.entries(FILTERS).map(([key, label]) => h('button', {
      class: 'menuitem' + (S.filter === key ? ' cur' : ''), 'aria-pressed': String(S.filter === key),
      onclick: () => { S.filter = key; closeSheet(); renderList(); },
    }, label, h('small', {}, String(n[key])))));
}
$('#menuListBtn').onclick = listMenuSheet;
$('#filterBtn').onclick = filterSheet;
$('#moreBtn').onclick = () => { S.shown += 40; renderList(); fillTitles(); };

// ---------- Renderer ----------
const R = {
  live: new Map(),   // "turn:step" -> {el, blocks: Map(index -> {type, text, el})}
  tools: new Map(),  // callId -> {el, ...}
  fin: new Set(),
  turn: null,        // {tools, sawStart}: the calls of the turn being rendered, for its summary card
  reset() { this.live.clear(); this.tools.clear(); this.fin = new Set(); this.turn = null; $('#msgs').replaceChildren(); },
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
        this.summary(r);
        this.turn = null;
        break;
      }
      case 'turn/start':
        this.turn = { tools: [], sawStart: true };
        break;
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
      (this.turn || (this.turn = { tools: [], sawStart: false })).tools.push(t);
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
    const diffs = window.dshReview ? window.dshReview.diffsOf(t) : null;
    let delta = null;
    if (diffs) {
      let adds = 0, dels = 0;
      for (const d of diffs) {
        const st = window.dshReview.diffStats(window.dshReview.diffLines(d.oldText, d.newText));
        adds += st.adds; dels += st.dels;
      }
      delta = deltaEl(adds, dels);
    }
    t.el.replaceChildren(
      h('summary', {}, h('span', { class: 'bullet' }, '⏺'), h('span', { class: 'name' }, prettyTool(t.name)), h('span', { class: 'sum' }, sum), delta),
      t.done && resLine ? h('div', { class: 'res' }, resLine) : null,
      detail);
    // Build detail lazily when opened (keeps long histories fast)
    const fill = () => {
      if (detail.childElementCount) return;
      if (diffs) {
        for (const d of diffs) detail.append(diffBlock(d));
        if (t.isError && t.result) detail.append(h('div', { class: 'lbl' }, 'error'), h('pre', {}, clip(t.result, 20000)));
        return;
      }
      if (t.args != null) detail.append(h('div', { class: 'lbl' }, 'input'), h('pre', {}, clip(prettyArgs(t.args), 20000)));
      const out = (t.rview && typeof t.rview.output === 'string' && t.rview.output) || t.result;
      if (out) detail.append(h('div', { class: 'lbl' }, t.isError ? 'error' : 'output'), h('pre', {}, clip(out, 20000)));
      if (t.rview && t.rview.exitCode != null) detail.append(h('div', { class: 'lbl' }, 'exit ' + t.rview.exitCode));
    };
    t.el.ontoggle = () => { if (t.el.open) fill(); };
    if (open) { t.el.open = true; fill(); }
  },
  // A card closing a turn that touched files or ran commands. A history window
  // can open mid-turn, so a turn whose start was not loaded says so.
  summary(reason) {
    const lib = window.dshReview, T = this.turn;
    if (!lib || !T || !T.tools.length) return;
    const s = lib.summarizeTurn(T.tools, reason);
    if (!s.files.length && !s.commands.length) return;
    this.add(turnCard(s, !T.sawStart));
    stick();
  },
};

// ---------- Review: diffs and turn summaries ----------
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function deltaEl(adds, dels) {
  return h('span', { class: 'delta' }, h('span', { class: 'add' }, '+' + adds), ' ', h('span', { class: 'del' }, '−' + dels));
}
// Paths as the model saw them, shortened against the session folder when inside it.
function relPath(p) {
  const cwd = S.cur && sessionMeta(S.cur.id).cwd;
  if (cwd && p.startsWith(cwd.replace(/\/+$/, '') + '/')) return p.slice(cwd.replace(/\/+$/, '').length + 1);
  return tildify(p);
}
const DIFF_MAX_LINES = 600;
function diffBlock(d) {
  const lib = window.dshReview;
  const ops = lib.diffLines(d.oldText, d.newText);
  const st = lib.diffStats(ops);
  const box = h('div', { class: 'diff' });
  box.append(h('div', { class: 'dhead' }, h('span', { class: 'dpath' }, relPath(d.path)), deltaEl(st.adds, st.dels)));
  const folded = lib.foldContext(ops);
  const body = h('div', { class: 'dbody' });
  for (let i = 0; i < folded.length; i++) {
    const o = folded[i];
    if (i >= DIFF_MAX_LINES) { body.append(h('div', { class: 'dl skip' }, `… ${plural(folded.length - i, 'more line')}`)); break; }
    if (o.op === 'skip') { body.append(h('div', { class: 'dl skip' }, `⋯ ${plural(o.count, 'unchanged line')}`)); continue; }
    if (o.op === 'cut') { body.append(h('div', { class: 'dl skip' }, `… ${plural(o.count, 'more changed line')} not shown`)); continue; }
    const cls = o.op === '+' ? 'add' : o.op === '-' ? 'del' : 'ctx';
    body.append(h('div', { class: 'dl ' + cls }, h('span', { class: 'sg', 'aria-hidden': 'true' }, o.op), o.text));
  }
  if (!ops.length) body.append(h('div', { class: 'dl skip' }, 'No line changes'));
  box.append(body);
  return box;
}
// Open a tool row from the summary card and bring it into view.
function revealTool(id) {
  const t = R.tools.get(id);
  if (!t) return;
  t.el.open = true;
  R.paintTool(t);
  t.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
const firstLine = (s) => String(s || '').split('\n')[0];
function turnCard(s, partial) {
  const verdict = { passed: '✓ passed', failed: '✗ failed', stopped: '■ stopped' }[s.outcome];
  const card = h('div', { class: 'turncard ' + s.outcome },
    h('div', { class: 'tc-head' }, h('b', {}, 'Turn summary'), h('span', { class: 'verdict ' + s.outcome }, verdict)),
    s.why ? h('div', { class: 'tc-why' }, s.why.charAt(0).toUpperCase() + s.why.slice(1)) : null);
  const MAX = 8;
  if (s.files.length) {
    card.append(h('div', { class: 'tc-sec' }, h('span', {}, plural(s.files.length, 'file') + ' changed'), deltaEl(s.adds, s.dels)));
    for (const f of s.files.slice(0, MAX)) {
      card.append(h('button', { type: 'button', class: 'tc-row', onclick: () => revealTool(f.callIds[f.callIds.length - 1]) },
        h('span', { class: 'tc-main' }, relPath(f.path)), deltaEl(f.adds, f.dels)));
    }
    if (s.files.length > MAX) card.append(h('div', { class: 'tc-more' }, `and ${s.files.length - MAX} more`));
  }
  if (s.commands.length) {
    card.append(h('div', { class: 'tc-sec' }, h('span', {}, plural(s.commands.length, 'command') + ' run' + (s.failedCommands ? `, ${s.failedCommands} failed` : ''))));
    // The latest commands matter most: the verdict rests on the last one.
    const shown = s.commands.slice(-MAX);
    if (s.commands.length > MAX) card.append(h('div', { class: 'tc-more' }, `${s.commands.length - MAX} earlier not shown`));
    for (const c of shown) {
      const mark = !c.done ? '·' : c.failed ? '✗' : c.noResult ? '?' : '✓';
      const exit = c.signal ? c.signal : c.exitCode != null ? 'exit ' + c.exitCode : '';
      card.append(h('button', { type: 'button', class: 'tc-row', onclick: () => revealTool(c.callId) },
        h('span', { class: 'tc-mark ' + (c.failed ? 'err' : c.done && !c.noResult ? 'ok' : '') }, mark),
        h('span', { class: 'tc-main mono' }, firstLine(c.title) || 'command'),
        exit ? h('span', { class: 'tc-exit' }, exit) : null));
    }
  }
  if (partial) card.append(h('div', { class: 'tc-more' }, 'Earlier steps of this turn are not loaded.'));
  return card;
}
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
  if (dictation.listening) dictateStop(); // the mic button is only in the chat view
  S.cur = { id, events: [], lastSeq: -1, loading: false, buffer: [], hasMore: false, gen: 0 };
  S.images = []; renderAttachments(); S.steer = false; queueEditing = null;
  $('#listView').hidden = true; $('#chatView').hidden = false;
  stopDashTick(); // the dashboard is off screen while a chat is open
  const m = sessionMeta(id);
  $('#title').textContent = S.titles.get(id) || basename(m.cwd) || 'Session';
  $('#subtitle').textContent = [tildify(m.cwd), m.agentPreset].filter(Boolean).join(' · ');
  R.reset(); pinned = true;
  renderRunning(); renderPending(); renderQueue();
  // Start collapsed and empty: the previous session's line must not linger over
  // this one while its history is still loading.
  $('#statusBreakdown').hidden = true;
  $('#statusLine').setAttribute('aria-expanded', 'false');
  renderStatusLine();
  await loadHistory();
  S.commands = [];
  remote('commands/list', { agentId: id }).then((c) => { if (S.cur && S.cur.id === id) S.commands = Array.isArray(c) ? c : []; }).catch(() => {});
  loadModel(id);
}
function showList({ push = true } = {}) {
  if (push && location.hash) history.pushState(null, '', location.pathname);
  if (dictation.listening) dictateStop();
  S.cur = null;
  $('#chatView').hidden = true; $('#listView').hidden = false;
  loadSessions();
}
window.addEventListener('popstate', route);
function route() {
  const m = /^#s[=/](.+)$/.exec(location.hash);
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
    if (v.projections && v.projections.values) {
      for (const [key, value] of Object.entries(v.projections.values)) setProjection(cur.id, key, value, -1);
    }
    rerender(true);
    renderRunning(); // the turn's start time is only known once history is in
    renderStatusLine();
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
  renderStatusLine(); // the per-turn breakdown follows the paged-in history
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
  if (t === 'turn/start') { S.running.set(cur.id, true); if (typeof frame.event.time === 'number') S.turnStart.set(cur.id, frame.event.time); }
  if (t === 'turn/end') { S.turnStart.delete(cur.id); S.running.set(cur.id, false); }
  R.apply(frame);
  if (t === 'turn/start' || t === 'turn/end') renderRunning();
}

// ---------- Running / queue ----------
let workTimer = null;
// When the running turn began, from dsh's own event times, so reopening a session
// mid-turn shows the real elapsed time rather than restarting at 0.
function turnStartTime(cur) {
  const evs = cur.events || [];
  let firstMsg = null, oldest = null, ended = false;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i].event;
    if (!e) continue;
    if (e.type === 'turn/end') { ended = true; break; } // even without a time, so an older turn is never picked up
    if (typeof e.time !== 'number') continue;
    oldest = e.time;
    if (e.type === 'turn/start') return e.time;
    if (e.type === 'user/message') firstMsg = e.time; // keeps the earliest since the last turn ended
  }
  // A long turn can start before the loaded history window: prefer the start we saw live,
  // then the earliest message since the last turn, then the oldest loaded event (a lower bound beats 0).
  if (!ended && S.turnStart.has(cur.id)) return S.turnStart.get(cur.id);
  if (firstMsg) return firstMsg;
  return !ended && cur.hasMore ? oldest : null;
}
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
    const t0 = turnStartTime(cur) || Date.now();
    const tick = () => { $('#workingText').textContent = `Working… ${Math.max(0, Math.floor((Date.now() - t0) / 1000))}s`; }; // clamp: phone and laptop clocks can differ slightly
    tick(); workTimer = setInterval(tick, 1000);
    stick();
  }
}
// Queued messages, each with edit and remove. dsh's session.updateQueue acts on one
// item by id; an edit replaces the message's content blocks, so images are kept and
// only the text is swapped. The list is never changed locally: the next
// session/queue event re-renders it.
let queueEditing = null; // {sessionId, id} of the item being edited, so a queue event mid-edit keeps the editor
let queueDraft = '';      // its unsaved text, which survives those re-renders
function renderQueue() {
  const cur = S.cur; if (!cur) return;
  const all = S.queues.get(cur.id) || [];
  const items = all.filter((i) => i.placement !== 'context');
  const el = $('#queueLine');
  el.hidden = !items.length;
  if (queueEditing && queueEditing.sessionId !== cur.id) queueEditing = null; // another session: drop quietly
  if (queueEditing && !items.some((it) => it.id === queueEditing.id)) {
    // Only "sent" if it left the queue; an item that moved into context was not sent.
    if (!all.some((it) => it.id === queueEditing.id)) toast('That message was already sent');
    queueEditing = null;
  }
  if (!items.length) { el.replaceChildren(); return; }
  // Keep the open editor's node rather than rebuilding it: re-focusing a new textarea
  // outside a tap would drop the iOS keyboard and the caret.
  const keep = queueEditing && el.querySelector(`.qitem.editing[data-id="${CSS.escape(queueEditing.id)}"]`);
  el.replaceChildren(h('div', { class: 'qcount' }, `${items.length} message${items.length > 1 ? 's' : ''} queued`),
    ...items.map((it) => (queueEditing && it.id === queueEditing.id ? (keep || queueEditor(cur.id, it)) : queueRow(cur.id, it))));
}
function queueText(it) { return textOf((it.message && it.message.content) || []); }
function queueRow(sessionId, it) {
  const imgs = ((it.message && it.message.content) || []).filter((b) => b.type === 'image').length;
  const row = h('div', { class: 'qitem' },
    h('div', { class: 'qtext' }, queueText(it) || (imgs ? '' : '(empty)'), imgs ? ` 🖼 ${imgs}` : null));
  const edit = h('button', { type: 'button', class: 'qact', 'aria-label': 'Edit queued message' }, '✎');
  const rm = h('button', { type: 'button', class: 'qact', 'aria-label': 'Remove queued message' }, '✕');
  // Focus inside the tap itself: iOS only raises the keyboard for focus during a user gesture.
  edit.onclick = () => { queueEditing = { sessionId, id: it.id }; queueDraft = queueText(it); renderQueue(); const b = $('#queueLine .qedit'); if (b) b.focus(); };
  rm.onclick = () => updateQueued(sessionId, it.id, { kind: 'remove' }, row);
  row.append(edit, rm);
  return row;
}
function queueEditor(sessionId, it) {
  const box = h('textarea', { rows: '3', class: 'qedit' });
  box.value = queueDraft;
  box.oninput = () => { queueDraft = box.value; };
  const save = h('button', { type: 'button', class: 'qact wide accent' }, 'Save');
  const cancel = h('button', { type: 'button', class: 'qact wide' }, 'Cancel');
  const row = h('div', { class: 'qitem editing', 'data-id': it.id }, box, h('div', { class: 'row' }, cancel, save));
  cancel.onclick = () => { queueEditing = null; renderQueue(); };
  save.onclick = async () => {
    const text = box.value;
    const others = ((it.message && it.message.content) || []).filter((b) => b.type !== 'text');
    const content = text.trim() ? [{ type: 'text', text }, ...others] : others;
    if (!content.length) { toast('Nothing left to send: use ✕ to remove it'); return; }
    if (await updateQueued(sessionId, it.id, { kind: 'edit', content }, row)) {
      // Show the saved text now; the next session/queue event replaces this copy anyway.
      const list = S.queues.get(sessionId) || [];
      S.queues.set(sessionId, list.map((q) => (q.id === it.id ? { ...q, message: { ...q.message, content } } : q)));
      queueEditing = null; renderQueue();
    }
  };
  return row;
}
async function updateQueued(sessionId, itemId, action, row) {
  const btns = row.querySelectorAll('button');
  btns.forEach((b) => { b.disabled = true; });
  try {
    await rpc('session.updateQueue', { sessionId, itemId, action });
    // Buttons stay disabled on success: the row is stale until the session/queue event
    // replaces it, and a second tap would act on an item dsh no longer has.
    return true;
  } catch (e) {
    // Most often the item was already sent: the turn started before the tap landed.
    toast((action.kind === 'remove' ? 'Remove' : 'Edit') + ' failed: ' + e.message, 4000);
    btns.forEach((b) => { b.disabled = false; });
    return false;
  }
}
$('#stopBtn').onclick = async () => {
  if (!S.cur) return;
  try { await rpc('session.cancel', { sessionId: S.cur.id }); toast('Stopping…'); } catch (e) { toast('Stop failed: ' + e.message); }
};
$('#steerBtn').onclick = () => { S.steer = !S.steer; renderRunning(); };

// ---------- Status line ----------
// A compact line under the session header: which model and route are in use,
// how full the context is, the tokens this session has spent, and what that
// works out to in dollars. Every part is dropped when dsh has not reported it,
// so nothing here invents a zero.
const BUCKETS = [
  ['uncachedInputTokens', 'in'],
  ['outputTokens', 'out'],
  ['cacheReadTokens', 'cache read'],
  ['cacheWriteTokens', 'cache write'],
];
const zeroBuckets = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
// Token figures arrive as whatever dsh sent; anything unusable counts as none.
const nonzero = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
function sumBuckets(buckets) {
  let total = 0;
  for (const [key] of BUCKETS) total += buckets[key];
  return total;
}
// The two sides name a bucket differently: a usage sample reports uncached
// input as `inputTokens`, while the tokenUsage projection counts it as
// `uncachedInputTokens`. Mapping both into the projection's names is what lets
// the per-turn rows sum to the session total beside them.
function projectedBuckets(usage) {
  const out = zeroBuckets();
  for (const [key] of BUCKETS) out[key] = nonzero(usage[key]);
  return out;
}
function eventBuckets(usage) {
  return {
    uncachedInputTokens: nonzero(usage.inputTokens),
    outputTokens: nonzero(usage.outputTokens),
    cacheReadTokens: nonzero(usage.cacheReadTokens),
    cacheWriteTokens: nonzero(usage.cacheWriteTokens),
  };
}
// Per-turn usage across the loaded history. A step reports usage twice (an early
// usage chunk, then the finalized message), so one turn/step's sample replaces
// its predecessor rather than adding to it — token-meter's rule, which is what
// keeps these turns adding up to the session projection.
function turnUsage(events) {
  const steps = new Map(); // "turn:step" -> {turn, buckets}
  for (const frame of events || []) {
    const ev = frame && frame.event;
    if (!ev) continue;
    const d = ev.data || {};
    if (typeof d.turn !== 'number' || typeof d.step !== 'number') continue;
    let usage = null;
    if (ev.type === 'assistant/message') usage = d.usage;
    else if (ev.type === 'assistant/chunk' && d.chunk && d.chunk.type === 'usage') usage = d.chunk.usage;
    if (!usage) continue;
    steps.set(`${d.turn}:${d.step}`, { turn: d.turn, buckets: eventBuckets(usage) });
  }
  const turns = new Map();
  for (const step of steps.values()) {
    const acc = turns.get(step.turn) || zeroBuckets();
    for (const [key] of BUCKETS) acc[key] += step.buckets[key];
    turns.set(step.turn, acc);
  }
  return [...turns].sort((a, b) => a[0] - b[0]).map(([turn, buckets]) => ({ turn, buckets }));
}
// dsh has no model projection. The session's current selection comes from
// `session.models`, and the log records what a request actually ran as
// `request/context` (or the config inside `request/header`), which is the
// fallback when that call has not answered.
function routeFromEvents(events) {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const ev = events[i] && events[i].event;
    if (!ev) continue;
    const d = ev.data || {};
    if (ev.type === 'request/context') {
      if (d.provider && d.model) return { provider: d.provider, model: d.model };
    } else if (ev.type === 'request/header') {
      const config = d.header && d.header.config;
      if (config && config.provider && config.model) return { provider: config.provider, model: config.model };
    }
  }
  return null;
}
const routeFor = (cur) => S.model.get(cur.id) || routeFromEvents(cur.events);
async function loadModel(id) {
  try {
    const v = await rpc('session.models', { sessionId: id });
    const current = v && v.current;
    if (!current || !current.model) return;
    S.model.set(id, { provider: current.provider, model: current.model });
    if (S.cur && S.cur.id === id) renderStatusLine();
  } catch {} // the log fallback still covers a session whose models call fails
}
// Read once and cache: the renderer runs on every projection push.
function priceOverrides() {
  const lib = window.dshPrices;
  if (!lib) return {};
  if (S.prices === null) S.prices = lib.loadPriceOverrides();
  return S.prices;
}
function priceRowFor(cur) {
  const lib = window.dshPrices;
  if (!lib) return null;
  const route = routeFor(cur);
  return lib.priceFor(route && route.model, priceOverrides());
}
// `contextPressure` is the wire view of dsh-token-meter's unit: provider-anchored
// prompt tokens plus the newest route capacity. Neither side alone is a reading,
// so both must be present or there is no fill to show.
function contextFill(cp) {
  if (!cp) return null;
  const used = typeof cp.projectedTokens === 'number' ? cp.projectedTokens : cp.pressureTokens;
  const capacity = cp.contextWindow;
  if (typeof used !== 'number' || typeof capacity !== 'number' || capacity <= 0) return null;
  const pct = Math.min(100, Math.round((used / capacity) * 100));
  return { pct, level: pct >= 90 ? ' err' : (pct >= 70 ? ' warn' : '') };
}
function renderStatusLine() {
  const bar = $('#statusBar');
  const cur = S.cur;
  if (!cur) { bar.hidden = true; renderStatusBreakdown(); return; }
  const parts = [];

  const route = routeFor(cur);
  if (route) parts.push(h('span', { class: 'status-part model' }, route.model, route.provider ? ` · ${route.provider}` : null));

  // Context fill: the provider-anchored prompt size over the route's capacity.
  // dsh reports neither until a request has run, so a fresh session shows no bar.
  const fill = contextFill(projectionValue(cur.id, 'contextPressure'));
  if (fill) {
    const bar = h('span', { class: 'status-fill' + fill.level });
    bar.style.setProperty('--fill', fill.pct + '%');
    parts.push(h('span', { class: 'status-part' },
      h('span', { class: 'status-track' }, bar),
      h('span', { class: 'status-pct' }, fill.pct + '%')));
  }

  // Session tokens. Buckets dsh has not billed stay out of the line rather than
  // reading as zero, and a session with no usage yet shows no token part at all.
  const usage = projectionValue(cur.id, 'tokenUsage');
  const buckets = usage ? projectedBuckets(usage) : null;
  const billed = buckets ? sumBuckets(buckets) : 0;
  if (billed > 0) {
    // Four labeled buckets are wider than a phone, so this part alone wraps
    // between them; each bucket stays whole so a break never splits a figure
    // from its label. `.tokens` clears the nowrap the other parts keep.
    const kids = [];
    for (const [key, label] of BUCKETS) {
      if (buckets[key] <= 0) continue;
      if (kids.length) kids.push(' · ');
      kids.push(h('span', { class: 'bucket' }, `${label} ${fmtTokens(buckets[key])}`));
    }
    parts.push(h('span', { class: 'status-part tokens' }, kids));
    // Only price a model we know. Until `session.models` answers, the route is
    // unknown rather than unpriced, and "cost n/a" would be a claim about a
    // model we have not identified yet.
    if (route) {
      const cost = window.dshPrices ? window.dshPrices.costOf(buckets, priceRowFor(cur)) : null;
      parts.push(h('span', { class: 'status-part' }, cost === null ? 'cost n/a' : `est. ${fmtUsd(cost)}`));
    }
  }

  $('#statusSummary').replaceChildren(...parts);
  bar.hidden = parts.length === 0;
  const caret = $('#statusCaret');
  caret.hidden = parts.length === 0 || !turnUsage(cur.events).length;
  if (!$('#statusBreakdown').hidden) renderStatusBreakdown();
}
function renderStatusBreakdown() {
  const box = $('#statusBreakdown');
  const cur = S.cur;
  if (!cur) { box.replaceChildren(); return; }
  const lib = window.dshPrices;
  const row = priceRowFor(cur);
  const turns = turnUsage(cur.events);
  if (!turns.length) { box.replaceChildren(h('div', { class: 'status-note' }, 'No per-turn usage reported yet.')); return; }
  // A table rather than a line per turn: four buckets plus a cost do not fit
  // across a phone, and truncating them would hide the numbers this panel exists
  // to show. Columns are shared, so a bucket dsh billed nothing for reads as 0
  // here — the compact line above is the place where a spent-nothing bucket is
  // left out.
  const table = h('div', { class: 'status-table' });
  // Header cells; the four bucket columns are right-aligned to match their figures.
  for (const [label, alignRight] of [['turn', false], ['in', true], ['out', true], ['read', true], ['write', true], ['est.', false]]) {
    table.append(h('span', { class: 'th' + (alignRight ? ' num' : '') }, label));
  }
  for (const { turn, buckets } of turns) {
    const cost = lib ? lib.costOf(buckets, row) : null;
    table.append(
      h('span', { class: 'turn' }, String(turn)),
      h('span', { class: 'num' }, fmtTokens(buckets.uncachedInputTokens) || '0'),
      h('span', { class: 'num' }, fmtTokens(buckets.outputTokens) || '0'),
      h('span', { class: 'num' }, fmtTokens(buckets.cacheReadTokens) || '0'),
      h('span', { class: 'num' }, fmtTokens(buckets.cacheWriteTokens) || '0'),
      h('span', { class: 'cost' }, cost === null ? 'n/a' : fmtUsd(cost)));
  }
  box.replaceChildren(table, h('div', { class: 'status-note' }, 'read and write are cache read and cache write.'));
  // The line above counts the whole session log; these rows only cover the turns
  // paged in, so say so instead of letting the two look like they disagree.
  if (cur.hasMore) box.append(h('div', { class: 'status-note' }, 'Earlier turns are not loaded yet.'));
}
$('#statusLine').onclick = () => {
  const line = $('#statusLine');
  const box = $('#statusBreakdown');
  const open = box.hidden;
  if (open) renderStatusBreakdown();
  box.hidden = !open;
  line.setAttribute('aria-expanded', String(open));
};

// ---------- Running now ----------
// One card per session that is doing something: a turn in flight, a live
// background job, or a live subagent. Everything comes from existing dsh
// surfaces — `session.list` carries a projection baseline (todos,
// contextPressure, subagentTiming, sessionListMetadata), the mux pushes
// `session/projection` and `session/jobs` frames, and `subagent.list` answers
// the direct-child catalog for one parent.
const DASH_KEYS = new Set(['todos', 'contextPressure', 'tokenUsage', 'subagent', 'subagentTiming', 'sessionListMetadata', 'title']);
const dashLive = (j) => !!j && (j.status === 'running' || j.status === 'stopping');
// Projection frames arrive per streamed chunk, so a render is coalesced to one
// per macrotask and then skipped entirely when the signature did not move.
let dashPending = null;
function scheduleDashboard() {
  if (dashPending) return;
  dashPending = setTimeout(() => { dashPending = null; renderDashboard(); }, 0);
  if (dashPending && dashPending.unref) dashPending.unref();
}
function liveJobs(id) { return (S.jobs.get(id) || []).filter(dashLive); }
function hasLiveAgent(id, depth = 0) {
  const tree = S.subagents.get(id);
  if (!tree || depth > 3) return false;
  return tree.entries.some((e) => e && e.kind === 'child' &&
    (e.activity === 'running' || (e.hasChildren && hasLiveAgent(e.id, depth + 1))));
}
// When the running turn began. Live turn/start events are exact; the list
// baseline's last human prompt is the best available anchor when the page
// opened mid-turn, and `updatedAt` covers a log we have not seen a prompt for.
function sessionStart(id) {
  const live = S.turnStart.get(id);
  if (typeof live === 'number') return live;
  const meta = projectionValue(id, 'sessionListMetadata');
  if (meta && typeof meta.lastPromptAt === 'number') return meta.lastPromptAt;
  const s = S.sessions.find((x) => x.sessionId === id);
  return s && typeof s.updatedAt === 'number' ? s.updatedAt : null;
}
// One definition of "still working", shared by Running now and the archive guard:
// a running turn, a live background job, or a live subagent.
function sessionIsWorking(id) { return !!S.running.get(id) || liveJobs(id).length > 0 || hasLiveAgent(id); }
function activeSessions() {
  const list = (S.sessions || []).filter((s) => sessionIsWorking(s.sessionId));
  return list.sort((a, b) => (sessionStart(b.sessionId) || b.updatedAt || 0) - (sessionStart(a.sessionId) || a.updatedAt || 0));
}
function toggleDashCard(id) {
  if (S.dashOpen.has(id)) S.dashOpen.delete(id); else S.dashOpen.add(id);
  dashSig = null;
  renderDashboard();
}
// ----- subagent catalogs -----
// The catalog is a snapshot, not a push, so it is refreshed while a card stays
// on screen. Children with children are followed a few levels down; the budget
// stops one pathological tree from turning a refresh into a crawl.
function ensureAgentTrees(list) {
  const now = Date.now();
  for (const s of list) {
    const id = s.sessionId;
    const cached = S.subagents.get(id);
    if (cached && now - cached.at < 8000) continue;
    if (S.agentsLoading.has(id)) continue;
    loadAgentTree(id, 0, { n: 0 }).catch(() => {});
  }
}
async function loadAgentTree(id, depth, budget) {
  if (budget.n >= 40 || depth > 3) return;
  budget.n++;
  S.agentsLoading.add(id);
  try {
    const v = await rpc('subagent.list', { parentSessionId: id });
    const entries = Array.isArray(v && v.entries) ? v.entries : [];
    S.subagents.set(id, { entries, parentAvailable: !!(v && v.parentAvailable), at: Date.now() });
    for (const e of entries) if (e && e.kind === 'child' && e.hasChildren) await loadAgentTree(e.id, depth + 1, budget);
  } catch {
    // Record the attempt anyway: a deployment with no subagent domain (or a
    // denied call) must not be retried on every render.
    if (!S.subagents.has(id)) S.subagents.set(id, { entries: [], parentAvailable: false, at: Date.now(), failed: true });
  } finally {
    S.agentsLoading.delete(id);
    scheduleDashboard();
  }
}
function flattenAgents(parentId, depth, out) {
  const tree = S.subagents.get(parentId);
  if (!tree || depth > 3) return out;
  for (const e of tree.entries) {
    out.push({ e, depth });
    if (e && e.kind === 'child' && e.hasChildren) flattenAgents(e.id, depth + 1, out);
  }
  return out;
}
// `subagentTiming` is dsh-subagent's own projection: an open interval while the
// child turns, and accumulated settled time once it ends.
function agentTiming(e) {
  const t = projectionValue(e.id, 'subagentTiming');
  if (!t) return null;
  if (t.active && typeof t.active.since === 'number') return { since: t.active.since, live: true };
  if (typeof t.settledMs === 'number' && t.settledMs > 0) return { settledMs: t.settledMs, live: false };
  return null;
}
function jobRow(j) {
  const live = dashLive(j);
  const row = h('div', { class: 'run-job' },
    h('span', { class: 'jdot ' + String(j.status || '') }),
    h('span', { class: 'jkind' }, j.kind || 'job'),
    h('span', { class: 'jlabel', title: j.label || '' }, j.label || ''));
  if (live && typeof j.startedAt === 'number') row.append(h('span', { class: 'jtime', 'data-since': String(j.startedAt) }, fmtElapsed(Date.now() - j.startedAt)));
  else row.append(h('span', { class: 'jtime' }, [j.status, j.detail].filter(Boolean).join(' · ')));
  return row;
}
function agentRow({ e, depth }) {
  const row = h('div', { class: 'run-agent' });
  row.style.setProperty('--depth', String(depth));
  if (e.kind === 'diagnostic') {
    row.append(h('span', { class: 'adot' }), h('span', { class: 'aname' }, e.id || 'subagent'), h('span', { class: 'afail' }, e.reason || 'unavailable'));
    return row;
  }
  const live = e.activity === 'running';
  row.append(h('span', { class: 'adot ' + (live ? 'running' : 'settled') }));
  row.append(h('span', { class: 'aname', title: e.id || '' }, e.label || e.id || 'subagent'));
  if (e.mode) row.append(h('span', { class: 'amode' }, e.mode));
  const t = agentTiming(e);
  if (t && t.live) row.append(h('span', { class: 'atime', 'data-since': String(t.since) }, fmtElapsed(Date.now() - t.since)));
  else if (t) row.append(h('span', { class: 'atime' }, fmtElapsed(t.settledMs)));
  return row;
}
function sessionCard(s) {
  const id = s.sessionId;
  const running = !!S.running.get(id);
  const start = running ? sessionStart(id) : null;
  const title = S.titles.get(id) || basename(s.cwd) || 'Session';
  const top = h('button', { class: 'run-top', type: 'button', 'aria-label': 'Open ' + title, onclick: () => openSession(id) },
    h('span', { class: 'run-dot' + (running ? '' : ' idle') }),
    h('span', { class: 'run-name' }, title),
    running && typeof start === 'number' ? h('span', { class: 'run-elapsed', 'data-since': String(start) }, fmtElapsed(Date.now() - start)) : null);

  const meters = [];
  const todos = projectionValue(id, 'todos');
  if (Array.isArray(todos) && todos.length) {
    const done = todos.filter((t) => t && t.status === 'completed').length;
    const pct = Math.round((done / todos.length) * 100);
    const fill = h('span', { class: 'run-fill' });
    fill.style.setProperty('--fill', pct + '%');
    meters.push(h('div', { class: 'run-meter' },
      h('span', { class: 'run-meter-label' }, 'todos'),
      h('span', { class: 'run-track' }, fill),
      h('span', { class: 'run-meter-value' }, `${done}/${todos.length}`)));
    const current = todos.find((t) => t && t.status === 'in_progress');
    if (current && current.content) meters.push(h('div', { class: 'run-current' }, current.content));
  }
  const cf = contextFill(projectionValue(id, 'contextPressure'));
  if (cf) {
    const fill = h('span', { class: 'run-fill' + cf.level });
    fill.style.setProperty('--fill', cf.pct + '%');
    meters.push(h('div', { class: 'run-meter' },
      h('span', { class: 'run-meter-label' }, 'ctx'),
      h('span', { class: 'run-track' }, fill),
      h('span', { class: 'run-meter-value' }, cf.pct + '%')));
  }

  const jobs = S.jobs.get(id) || [];
  const live = jobs.filter(dashLive);
  const agents = flattenAgents(id, 0, []);
  const bits = [];
  if (live.length) bits.push(`${live.length} running job${live.length > 1 ? 's' : ''}`);
  else if (jobs.length) bits.push(`${jobs.length} job${jobs.length > 1 ? 's' : ''}`);
  if (agents.length) bits.push(`${agents.length} subagent${agents.length > 1 ? 's' : ''}`);
  const expanded = S.dashOpen.has(id);
  const more = h('button', { class: 'run-more', type: 'button', 'aria-expanded': String(expanded), onclick: () => toggleDashCard(id) },
    h('span', { class: 'run-more-txt' }, bits.length ? bits.join(' · ') : (running ? 'working' : 'idle')),
    h('span', { class: 'run-caret', 'aria-hidden': 'true' }, '▾'));

  const detail = h('div', { class: 'run-detail' });
  if (jobs.length) {
    detail.append(h('div', { class: 'run-sec-title' }, 'Background jobs'));
    const ordered = jobs.slice().sort((a, b) => (dashLive(b) ? 1 : 0) - (dashLive(a) ? 1 : 0));
    for (const j of ordered.slice(0, 8)) detail.append(jobRow(j));
    if (ordered.length > 8) detail.append(h('div', { class: 'run-empty' }, `+${ordered.length - 8} more`));
  }
  if (agents.length) {
    detail.append(h('div', { class: 'run-sec-title' }, 'Subagents'));
    for (const node of agents.slice(0, 24)) detail.append(agentRow(node));
    if (agents.length > 24) detail.append(h('div', { class: 'run-empty' }, `+${agents.length - 24} more`));
  }
  if (!jobs.length && !agents.length) detail.append(h('div', { class: 'run-empty' }, 'No jobs or subagents.'));
  detail.hidden = !expanded;
  return h('article', { class: 'run-card', 'data-session': id }, top, h('div', { class: 'run-meters' }, meters), more, detail);
}
function agentsSig(parentId, depth) {
  const tree = S.subagents.get(parentId);
  if (!tree || depth > 3) return '';
  const out = [];
  for (const e of tree.entries) {
    out.push([e.kind, e.id, e.activity, e.mode, e.label, e.reason].filter((x) => x != null).join(':'));
    const t = agentTiming(e);
    if (t) out.push(t.live ? 's' + t.since : 'd' + t.settledMs);
    if (e.kind === 'child' && e.hasChildren) out.push('(' + agentsSig(e.id, depth + 1) + ')');
  }
  return out.join(',');
}
// What the cards would render, with time-derived strings left out so the 1s
// ticker never forces a rebuild.
function dashboardSignature(list) {
  const parts = [];
  for (const s of list) {
    const id = s.sessionId;
    parts.push(id, S.running.get(id) ? 'run' : 'idle', 'S' + (sessionStart(id) || ''));
    const todos = projectionValue(id, 'todos');
    parts.push('T' + (Array.isArray(todos) ? todos.map((t) => ((t && t.status) || '?')[0] + ((t && t.content) || '')).join('\u0001') : ''));
    const cf = contextFill(projectionValue(id, 'contextPressure'));
    parts.push('C' + (cf ? cf.pct : ''));
    for (const j of S.jobs.get(id) || []) parts.push(['J', j.id, j.status, j.startedAt, j.finishedAt, j.detail, j.label].join(':'));
    parts.push('A' + agentsSig(id, 0));
    parts.push('O' + (S.dashOpen.has(id) ? '1' : '0'));
  }
  return parts.join('|');
}
let dashSig = null;
let dashTickTimer = null;
function startDashTick() {
  if (dashTickTimer) return;
  dashTickTimer = setInterval(tickDashboard, 1000);
  if (dashTickTimer && dashTickTimer.unref) dashTickTimer.unref();
}
function stopDashTick() { if (dashTickTimer) { clearInterval(dashTickTimer); dashTickTimer = null; } }
function tickDashboard() {
  const box = $('#running');
  if (!box || box.hidden) return;
  const now = Date.now();
  for (const el of box.querySelectorAll('[data-since]')) {
    const since = Number(el.getAttribute('data-since'));
    if (Number.isFinite(since)) el.textContent = fmtElapsed(now - since);
  }
}
function renderDashboard() {
  const box = $('#running');
  if (!box) return;
  if ($('#listView').hidden) { stopDashTick(); return; }
  const active = activeSessions();
  if (!active.length) { box.hidden = true; dashSig = null; stopDashTick(); return; }
  box.hidden = false;
  const sig = dashboardSignature(active);
  if (sig !== dashSig) {
    dashSig = sig;
    $('#runningCards').replaceChildren(...active.map(sessionCard));
    $('#runningCount').textContent = String(active.length);
  }
  const open = !S.dashCollapsed;
  $('#runningHead').setAttribute('aria-expanded', String(open));
  $('#runningCards').hidden = !open;
  startDashTick();
  ensureAgentTrees(active);
}
$('#runningHead').onclick = () => { S.dashCollapsed = !S.dashCollapsed; renderDashboard(); };

// ---------- Approvals & questions ----------
function renderPending() {
  const box = $('#pending');
  if (!S.cur) { box.replaceChildren(); return; }
  const cards = [];
  for (const a of S.approvals.values()) if (belongsToCur(a.sessionId)) cards.push(approvalCard(a));
  for (const q of S.questions.values()) {
    if (!belongsToCur(q.sessionId)) continue;
    const review = window.dshReview && window.dshReview.planReviewOf(q.questions);
    // Keep an open plan card's node: rebuilding it would drop the feedback box's focus
    // and, on iOS, the keyboard whenever another card arrives.
    const kept = review && box.querySelector(`.card.plan[data-rpc="${CSS.escape(q.rpcId)}"]`);
    cards.push(kept || (review ? planCard(q, review) : questionCard(q)));
  }
  box.replaceChildren(...cards);
  if (cards.length) stick();
}
// Plan mode asks for review through an ordinary question tagged plan-review, with
// the plan as markdown in its detail. It is drawn as the plan itself with
// approve and keep-planning buttons, answered with the option labels dsh named.
const planDrafts = new Map(); // rpcId -> feedback typed so far, kept across re-renders of #pending
function planCard(q, review) {
  const lib = window.dshReview;
  const sub = q.sessionId !== (S.cur && S.cur.id) ? ' (subagent)' : '';
  const body = h('div', { class: 'md plan-body' });
  body.append(mdNode(review.plan));
  const card = h('div', { class: 'card plan', 'data-rpc': q.rpcId },
    h('h4', {}, 'Plan review' + sub),
    review.question ? h('div', { class: 'why' }, review.question) : null,
    body);
  let fb = null;
  if (review.decline) {
    fb = h('textarea', { rows: '2', class: 'plan-fb', placeholder: `Feedback, sent with ${review.decline.label} (optional)` });
    fb.value = planDrafts.get(q.rpcId) || '';
    fb.oninput = () => { planDrafts.set(q.rpcId, fb.value); };
    card.append(fb);
  }
  const approve = h('button', { type: 'button', class: 'yes' }, review.approve.label);
  const keep = review.decline ? h('button', { type: 'button' }, review.decline.label) : null;
  // Closing the review without a decision: dsh stays in plan mode and waits for a message.
  const reply = h('button', { type: 'button' }, 'Reply instead');
  const btns = [approve, keep, reply].filter(Boolean);
  const settle = async (btn, result) => {
    const label = btn.textContent;
    btns.forEach((b) => { b.disabled = true; });
    btn.textContent = '…';
    try {
      await respond(q.rpcId, result);
      S.questions.delete(q.rpcId); planDrafts.delete(q.rpcId); renderPending(); badge();
      if (btn === reply) input.focus();
    } catch (e) { toast(e.message); btns.forEach((b) => { b.disabled = false; }); btn.textContent = label; }
  };
  approve.onclick = () => settle(approve, { ok: true, value: { sessionId: q.sessionId, answer: lib.planAnswer(review, true) } });
  if (keep) keep.onclick = () => settle(keep, { ok: true, value: { sessionId: q.sessionId, answer: lib.planAnswer(review, false, fb.value) } });
  reply.onclick = () => settle(reply, { ok: false, error: { code: 'cancelled', message: 'the user closed this question request', details: {} } });
  card.append(h('div', { class: 'row' }, ...btns));
  return card;
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
input.addEventListener('click', () => { if (!input.value.startsWith('/')) renderCmdPop(); });
input.addEventListener('keydown', (e) => {
  // Desktop convenience: Enter sends, Shift+Enter newline. On touch keyboards Enter inserts a newline.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover: hover)').matches) { e.preventDefault(); send(); }
});
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });

// `@path` mentions, same grammar as dsh's own clients (dsh-file-reference/grammar): an `@` that
// starts a word, or `@"` for paths with spaces. Candidates come from fileReferences/list.
function activeAtToken(line, col) {
  const before = line.slice(0, col);
  const q = /(?:^|\s)(@"([^"]*))$/u.exec(before);
  if (q) return { prefix: q[1], query: q[2], quoted: true };
  const p = /(?:^|\s)(@([^\s]*))$/u.exec(before);
  return p ? { prefix: p[1], query: p[2], quoted: false } : undefined;
}
function formatFileMention(c, keepQuote) {
  const path = c.kind === 'directory' ? c.path + '/' : c.path;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
  const quoted = keepQuote || /\s/u.test(path);
  if (!quoted) return '@' + path;
  return c.kind === 'directory' ? '@"' + path : '@"' + path + '"';
}
let mentionSeq = 0, mentionTimer = 0;
function renderMentionPop(tok) {
  const pop = $('#cmdpop');
  const cur = S.cur, seq = ++mentionSeq;
  clearTimeout(mentionTimer);
  if (!cur) { pop.hidden = true; return; }
  mentionTimer = setTimeout(async () => {
    let list;
    try { list = await remote('fileReferences/list', { agentId: cur.id, query: tok.query }); } catch { list = null; }
    // A newer keystroke, another session or a closed token makes this answer stale.
    if (seq !== mentionSeq || !S.cur || S.cur.id !== cur.id) return;
    const ok = Array.isArray(list) ? list.filter((c) => c && typeof c.path === 'string' && c.path) : [];
    if (!ok.length) { pop.hidden = true; return; }
    pop.replaceChildren(...ok.slice(0, 30).map((c) => {
      const slash = c.path.lastIndexOf('/');
      return h('button', { type: 'button', class: 'cmd mention', onclick: () => acceptMention(tok, c) },
        h('b', {}, c.path.slice(slash + 1) + (c.kind === 'directory' ? '/' : '')),
        slash >= 0 ? h('span', {}, c.path.slice(0, slash + 1)) : null);
    }));
    pop.hidden = false;
  }, 120);
}
function acceptMention(tok, c) {
  // The list was fetched for an earlier caret: re-read the token at the caret now, and
  // if it no longer matches (the caret moved, or it sits in another mention), refresh.
  const col = input.selectionStart;
  const now = activeAtToken(input.value, col);
  if (!now || now.prefix !== tok.prefix) { renderCmdPop(); return; }
  const text = formatFileMention(c, tok.quoted);
  if (text === undefined) { toast('That path has characters a mention cannot hold'); return; }
  const start = col - tok.prefix.length, tail = input.value.slice(col);
  if (start < 0) { renderCmdPop(); return; }
  // Files finish the mention with a space; directories stay open for the next level.
  const dir = c.kind === 'directory';
  const ins = dir || /^\s/.test(tail) ? text : text + ' ';
  input.value = input.value.slice(0, start) + ins + tail;
  input.focus(); input.setSelectionRange(start + ins.length, start + ins.length); grow();
  if (dir) renderCmdPop(); else { mentionSeq++; $('#cmdpop').hidden = true; }
}

function renderCmdPop() {
  const pop = $('#cmdpop');
  const tok = input.value.startsWith('/') ? undefined : activeAtToken(input.value, input.selectionStart);
  if (tok) { renderMentionPop(tok); return; }
  mentionSeq++; clearTimeout(mentionTimer);
  const m =/^\/(\S*)$/.exec(input.value);
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
  // Sending ends dictation first, so the last spoken words land in the message
  // rather than being written back into a composer that has moved on.
  if (dictation.listening) dictateStop();
  const text = input.value.trim();
  const images = S.images.slice();
  if (!text && !images.length) return;
  $('#cmdpop').hidden = true; mentionSeq++;
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

// ---------- Dictation (Web Speech API) ----------
// Chrome and Safari transcribe speech in the browser, so a tap fills the composer
// with no server round trip and nothing extra shipped. A browser without the API
// gets no button at all rather than one that cannot do anything.
const SpeechCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
const dictationSupported = typeof SpeechCtor === 'function';
const micBtn = $('#micBtn');
micBtn.hidden = !dictationSupported;

// The live session. `base` is the composer text as it was when dictation started,
// so speech is added to what is already typed instead of replacing it. `final`
// accumulates across the short runs Chrome and Safari end at each pause, and
// `interim` is the tail the recognizer is still revising.
const dictation = { rec: null, listening: false, base: '', final: '', interim: '', heard: false, startedAt: 0, dry: 0 };

// The composer text for the words recognized so far, with one separating space.
function dictateValue() {
  const spoken = dictation.final + dictation.interim;
  if (!dictation.base) return spoken;
  if (!spoken) return dictation.base;
  return /\s$/.test(dictation.base) ? dictation.base + spoken : dictation.base + ' ' + spoken;
}
function dictatePaint() {
  micBtn.classList.toggle('live', dictation.listening);
  micBtn.setAttribute('aria-pressed', dictation.listening ? 'true' : 'false');
  micBtn.setAttribute('aria-label', dictation.listening ? 'Stop dictation' : 'Dictate');
  micBtn.title = dictation.listening ? 'Stop dictation' : 'Dictate';
}
function dictateApply() {
  input.value = dictateValue();
  grow();
  renderCmdPop();
}
// End the session, keeping what was recognized and dropping the live state.
function dictateFinish() {
  const rec = dictation.rec;
  dictation.rec = null;
  dictation.listening = false;
  dictation.heard = false;
  dictation.dry = 0;
  if (rec) { try { rec.abort(); } catch {} }
  dictateApply();
  dictation.base = ''; dictation.final = ''; dictation.interim = '';
  dictatePaint();
}
function dictateFail(code) {
  dictateFinish();
  const denied = code === 'not-allowed' || code === 'service-not-allowed';
  toast(denied ? 'Dictation needs microphone access' : 'Dictation stopped: ' + (code || 'unknown error'));
}
function dictateResults(e) {
  const results = e.results || [];
  const from = typeof e.resultIndex === 'number' ? e.resultIndex : 0;
  let interim = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const text = (r && r[0] && r[0].transcript) || '';
    if (!text) continue;
    dictation.heard = true;
    if (r.isFinal) { if (i >= from) dictation.final += text; }
    else interim += text;
  }
  dictation.interim = interim;
  dictateApply();
}
// One recognition run. Both browsers end a run at every pause even with
// `continuous` set, so onend opens a fresh one until the button is tapped off.
function dictateRun() {
  const rec = new SpeechCtor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  rec.onresult = (e) => { if (dictation.rec === rec) dictateResults(e); };
  rec.onerror = (e) => {
    const code = e && e.error;
    if (dictation.rec !== rec || code === 'no-speech' || code === 'aborted') return;
    dictateFail(code);
  };
  rec.onend = () => {
    if (dictation.rec !== rec) return;
    dictation.rec = null;
    if (!dictation.listening) { dictateFinish(); return; }
    // Three runs in a row that die with nothing heard and no time to listen mean
    // the service is not coming back; an ordinary silent pause is left to restart.
    if (!dictation.heard && Date.now() - dictation.startedAt < 600) {
      if (++dictation.dry >= 3) { dictateFail('unavailable'); return; }
    } else dictation.dry = 0;
    dictateRun();
  };
  dictation.rec = rec;
  dictation.heard = false;
  dictation.startedAt = Date.now();
  try { rec.start(); } catch { dictateFail('start'); }
}
function dictateStart() {
  if (!dictationSupported || dictation.listening) return;
  dictation.base = input.value;
  dictation.final = '';
  dictation.interim = '';
  dictation.listening = true;
  dictatePaint();
  dictateRun();
}
function dictateStop() {
  if (!dictation.listening) return;
  // Fold the unconfirmed tail in: the stop tap should not drop the last phrase.
  dictation.final += dictation.interim;
  dictation.interim = '';
  dictateFinish();
}
micBtn.addEventListener('click', () => { dictation.listening ? dictateStop() : dictateStart(); });
dictatePaint();

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

// ---------- Prompt templates ----------
// Saved prompt templates live in localStorage under "dsh-rc.templates" as
// [{name, text}]; every read and write is wrapped so it still works
// without storage.
const TEMPLATES_KEY = 'dsh-rc.templates';
let templates = [];
function loadTemplates() {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(v)) return [];
    return v.filter((t) => t && typeof t.name === 'string' && typeof t.text === 'string');
  } catch { return []; }
}
templates = loadTemplates();
function saveTemplates() {
  try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates)); return true; } catch { return false; }
}
// Two sibling buttons, not a control nested inside a button: taps on an element
// inside a <button> are not reliably delivered to that element.
function templateRow(i, t, use, del) {
  return h('div', { class: 'tmplrow' },
    h('button', { type: 'button', class: 'tmplmain', onclick: () => use(i) }, h('b', {}, t.name), h('small', {}, t.text.slice(0, 100) || '(empty)')),
    h('button', { type: 'button', class: 'tmplx', 'aria-label': 'Delete ' + t.name, onclick: (e) => del(i, e.currentTarget) }, '✕'));
}
function templatesSheet() {
  // Remember the cursor up front: opening the sheet blurs the composer and
  // some browsers drop the selection on blur.
  const [a, b] = [input.selectionStart, input.selectionEnd];
  const list = h('div', { class: 'tmpl-list' });
  const render = () => {
    if (!templates.length) {
      list.replaceChildren(h('div', { class: 'note' }, 'No templates saved yet. Type a name below to save the composer text as one.'));
    } else {
      list.replaceChildren(...templates.map((t, i) => templateRow(i, t, insertTemplate, deleteTemplate)));
    }
  };
  function insertTemplate(i) {
    const t = templates[i];
    const len = input.value.length;
    const start = Math.min(a ?? len, len), end = Math.min(b ?? len, len);
    input.value = input.value.slice(0, start) + t.text + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + t.text.length;
    grow();
    closeSheet();
    input.focus();
  }
  // Native confirm()/prompt() are unreliable in iOS Home Screen apps, so delete
  // asks for a second tap on the same ✕ instead, and the name is typed in the sheet.
  let armed = -1;
  function deleteTemplate(i, btn) {
    if (armed !== i) {
      armed = i;
      list.querySelectorAll('.tmplx').forEach((x) => { x.textContent = '✕'; x.classList.remove('armed'); });
      btn.textContent = 'Delete?'; btn.classList.add('armed');
      return;
    }
    armed = -1;
    templates.splice(i, 1);
    if (!saveTemplates()) { templates = loadTemplates(); render(); toast('Could not delete: this browser refused storage'); return; }
    render();
    toast('Template deleted');
  }
  render();
  const nameIn = h('input', { type: 'text', placeholder: 'Name for the current text', enterkeyhint: 'done' });
  openSheet(h('h3', {}, 'Prompt templates'), list,
    h('label', {}, 'Save the composer text as a template'), nameIn,
    h('button', { type: 'button', class: 'go', onclick: () => {
      const name = nameIn.value.trim();
      const text = input.value;
      if (!name) { toast('Name is required'); return; }
      if (!text.trim()) { toast('Nothing to save: the composer is empty'); return; }
      templates.push({ name, text });
      if (!saveTemplates()) { templates.pop(); toast('Could not save: this browser refused storage'); return; }
      nameIn.value = '';
      render();
      toast('Template saved');
    } }, 'Save template'));
}
$('#tmplBtn').onclick = templatesSheet;

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
  const notifState = h('small', {}, 'Approvals, questions, finished turns');
  const notifRow = h('button', { class: 'menuitem', onclick: () => notificationsSheet() }, 'Notifications', notifState);
  refreshPushState().then((st) => { notifState.textContent = pushStateLabel(st); }).catch(() => {});
  openSheet(h('h3', {}, $('#title').textContent),
    h('button', { class: 'menuitem', onclick: modelSheet }, 'Model', h('small', {}, 'Switch the model for this session')),
    h('button', { class: 'menuitem', onclick: pricesSheet }, 'Prices', h('small', {}, 'Override the price table behind "est. cost"')),
    h('button', { class: 'menuitem', onclick: commandsSheet }, 'Commands', h('small', {}, 'Slash commands available here')),
    notifRow,
    h('button', { class: 'menuitem', onclick: renameSheet }, 'Rename'),
    h('button', { class: 'menuitem', onclick: forkSession }, 'Fork', h('small', {}, 'Branch a new session from the last finished turn')),
    h('button', { class: 'menuitem', onclick: exportSheet }, 'Export log', h('small', {}, 'Download this session as a ZIP')),
    h('button', { class: 'menuitem', onclick: archiveSheet }, 'Archive', h('small', {}, 'Hide it from the session list')),
    h('button', { class: 'menuitem', onclick: pluginsSheet }, 'Plugins & connectors', h('small', {}, 'What this dsh has loaded')),
    h('button', { class: 'menuitem', onclick: () => { closeSheet(); loadHistory(); } }, 'Refresh'),
    location.pathname.replace(/\/+$/, '') ? h('a', { class: 'menuitem', href: '/', style: 'color:inherit;text-decoration:none' }, 'Open full dsh web UI') : null);
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
            await loadModel(cur.id); // relabel the status line for the new route
            toast('Model: ' + (m.name || m.id)); closeSheet();
          } catch (e) { toast('Switch failed: ' + e.message, 4000); }
        } }, (isCur ? '✓ ' : '') + (m.name || m.id), m.description ? h('small', {}, m.description) : null));
      }
    }
    openSheet(...kids);
  } catch (e) { openSheet(h('h3', {}, 'Model'), h('div', { class: 'note err' }, e.message)); }
}
// Prices sheet: the est. cost numbers come from a shipped table that goes stale,
// so any model prefix can be re-priced here without shipping a new build.
function pricesSheet() {
  const lib = window.dshPrices;
  if (!lib) {
    openSheet(h('h3', {}, 'Prices'), h('div', { class: 'note err' }, 'The price table did not load, so estimated cost stays "n/a".'));
    return;
  }
  const saved = priceOverrides();
  const box = h('textarea', { rows: '9', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' });
  box.value = Object.keys(saved).length ? JSON.stringify(saved, null, 2) : '';
  const save = h('button', { type: 'button', class: 'go' }, 'Save prices');
  const clear = h('button', { type: 'button', class: 'ghost wide' }, 'Clear overrides');
  save.onclick = () => {
    let rows;
    try { rows = lib.parsePriceOverrides(box.value); }
    catch (e) { toast('Prices: ' + e.message, 5000); return; }
    if (!lib.savePriceOverrides(rows)) { toast('Could not save: this browser refused storage', 5000); return; }
    S.prices = rows; // the renderer caches reads, so hand it the new rows
    renderStatusLine();
    toast(Object.keys(rows).length ? 'Prices saved' : 'Overrides cleared');
    closeSheet();
  };
  clear.onclick = () => { box.value = ''; save.onclick(); };
  openSheet(h('h3', {}, 'Prices'),
    h('div', { class: 'note' }, 'USD per million tokens, as JSON keyed by model-id prefix. The longest matching prefix wins, and an override beats the built-in table. Blank clears them.'),
    h('div', { class: 'note' }, 'Fields: input, output, cacheRead, cacheWrite.'),
    box, save, clear);
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

// ---------- Fork, export, archive ----------
async function forkSession() {
  const cur = S.cur;
  closeSheet();
  toast('Forking…');
  try {
    const r = await rpc('session.fork', { sessionId: cur.id });
    const title = S.titles.get(cur.id);
    if (title) setTitle(r.sessionId, title);
    const m = sessionMeta(cur.id);
    S.sessions.unshift({ sessionId: r.sessionId, cwd: m.cwd, agentPreset: m.agentPreset, updatedAt: Date.now() });
    toast('Forked. You are in the new session.');
    openSession(r.sessionId);
  } catch (e) { toast(window.dshActions ? window.dshActions.forkFailure(e) : 'Fork failed: ' + e.message, 5000); }
}
function exportSheet() {
  const cur = S.cur;
  const withSub = h('input', { type: 'checkbox', id: 'expSub' });
  const go = h('button', { type: 'button', class: 'go' }, 'Download ZIP');
  go.onclick = () => {
    if (!window.dshActions) { toast('Export is unavailable: reload the page'); return; }
    // Click the link inside the tap: iOS Safari blocks a programmatic download once an
    // await has spent the user gesture, so there is no preflight here.
    const url = window.dshActions.exportUrl(cur.id, { includeDescendants: withSub.checked });
    const a = h('a', { href: url, download: window.dshActions.exportFilename(null, cur.id) });
    document.body.append(a); a.click(); a.remove();
    closeSheet(); toast('Downloading the log…');
  };
  openSheet(h('h3', {}, 'Export log'),
    h('div', { class: 'note' }, 'The stored log of this session as a ZIP.'),
    h('label', { for: 'expSub', style: 'display:flex;gap:10px;align-items:center;text-transform:none;letter-spacing:0;font-size:15px;color:inherit' },
      withSub, 'Include subagent logs'),
    go);
}
function archiveSheet() {
  const cur = S.cur;
  if (!window.dshActions) { toast('Archive is unavailable: reload the page'); return; }
  // dsh has no unarchive, and an archived session leaves the list and Running now: never
  // archive one that is still working.
  if (sessionIsWorking(cur.id)) {
    openSheet(h('h3', {}, 'Archive this session?'),
      h('div', { class: 'note' }, 'It is still working (a turn, a background job or a subagent is running). Stop it first: an archived session cannot be reopened from here.'),
      h('button', { type: 'button', class: 'menuitem', onclick: closeSheet }, 'OK'));
    return;
  }
  const go = h('button', { type: 'button', class: 'go' }, 'Archive session');
  go.onclick = async () => {
    go.disabled = true; go.textContent = 'Archiving…';
    try {
      const r = await rpc('workspace.archiveSession', { sessionId: cur.id });
      S.archived = window.dshActions.archiveSet(r.archivedSessionIds);
      S.sessions = window.dshActions.visibleSessions(S.sessions, S.archived);
      closeSheet(); toast('Archived');
      showList();
    } catch (e) { toast('Archive failed: ' + e.message, 4000); go.disabled = false; go.textContent = 'Archive session'; }
  };
  openSheet(h('h3', {}, 'Archive this session?'),
    h('div', { class: 'note' }, 'It leaves the session list, but its log is kept. dsh has no unarchive action, so this cannot be undone from here.'),
    go,
    h('button', { type: 'button', class: 'menuitem', onclick: closeSheet }, 'Cancel'));
}

// ---------- Notifications (Web Push) ----------
// The push API lives on the same origin under ./push/. Turning on must run
// inside the tap: iOS only grants Notification permission from a user gesture,
// and only when the page is installed to the Home Screen (iOS 16.4+).
let pushStateNow = 'off';
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
}
function pushStateLabel(state) {
  if (state === 'on') return 'On for this device';
  if (state === 'unsupported') return 'Not supported in this browser';
  return 'Off for this device';
}
function b64uToBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function ensureSW() {
  if (!('serviceWorker' in navigator)) throw new Error('no service worker support');
  await navigator.serviceWorker.register('./sw.js', { scope: './' });
  return swReady();
}
function swReady(timeoutMs = 10000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('service worker not ready')), timeoutMs)),
  ]);
}
async function refreshPushState() {
  if (!pushSupported()) { pushStateNow = 'unsupported'; return pushStateNow; }
  if (Notification.permission !== 'granted') { pushStateNow = 'off'; return pushStateNow; }
  try {
    const reg = await swReady();
    const sub = await reg.pushManager.getSubscription();
    pushStateNow = sub ? 'on' : 'off';
  } catch { pushStateNow = 'off'; }
  return pushStateNow;
}
async function enablePush() {
  if (!pushSupported()) throw new Error('push is not supported here');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('permission was not granted');
  const reg = await ensureSW();
  const keyRes = await fetch('./push/key');
  if (!keyRes.ok) throw new Error('key HTTP ' + keyRes.status);
  const { key } = await keyRes.json();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  const res = await fetch('./push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
  if (!res.ok) throw new Error('subscribe HTTP ' + res.status);
  pushStateNow = 'on';
}
async function disablePush() {
  const reg = await swReady();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    try { await fetch('./push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch {}
    await sub.unsubscribe();
  }
  pushStateNow = 'off';
}
async function sendTestPush() {
  const res = await fetch('./push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error('test HTTP ' + res.status);
}
async function notificationsSheet() {
  openSheet(h('h3', {}, 'Notifications'), h('div', { class: 'note' }, 'Checking…'));
  const state = await refreshPushState();
  const kids = [h('h3', {}, 'Notifications')];
  if (state === 'unsupported') {
    kids.push(h('div', { class: 'note' }, 'Push notifications are not supported in this browser.'));
    if (isIOS() && !isStandalone()) kids.push(h('div', { class: 'note' }, 'Add to Home Screen first (iOS 16.4+).'));
    openSheet(...kids);
    return;
  }
  kids.push(h('div', { class: 'note' }, pushStateLabel(state) + '.'));
  if (state === 'on') {
    kids.push(h('button', { class: 'menuitem', onclick: async () => {
      try { await sendTestPush(); toast('Test notification sent'); closeSheet(); }
      catch (e) { toast('Test failed: ' + e.message, 4000); }
    } }, 'Send test', h('small', {}, 'Notify every subscribed device')));
    kids.push(h('button', { class: 'menuitem', onclick: async () => {
      try { await disablePush(); toast('Notifications off'); } catch (e) { toast('Could not turn off: ' + e.message, 4000); }
      notificationsSheet();
    } }, 'Turn off'));
  } else {
    kids.push(h('button', { class: 'menuitem', onclick: async () => {
      try { await enablePush(); toast('Notifications on'); } catch (e) { toast('Could not turn on: ' + e.message, 4000); }
      notificationsSheet();
    } }, 'Turn on', h('small', {}, 'From this tap, then approve the browser prompt')));
  }
  openSheet(...kids);
}

// ---------- Tunnel QR ----------
// With --tunnel the server knows its public URL; show it as a QR code so a phone
// can open it by scanning. The code holds only the URL, never a login.
async function loadTunnelUrl() {
  try {
    const res = await fetch('./tunnel');
    if (!res.ok) return null;
    const { url } = await res.json();
    return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
  } catch { return null; }
}
async function tunnelSheet() {
  const url = await loadTunnelUrl();
  if (!url) { S.tunnelUrl = null; toast('No tunnel is running'); return; }
  // qr.js is optional like the other helper scripts: without it, still show the address.
  let tile = null;
  if (window.dshQr) {
    try {
      const code = window.dshQr.encode(url);
      // Whole device pixels per module, so the browser never resamples the code (a
      // stretched canvas can drop or double module columns and stop it scanning).
      const quiet = 4, modules = code.size + quiet * 2, dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
      const scale = Math.max(dpr, Math.floor((260 * dpr) / modules));
      const canvas = h('canvas', { role: 'img', 'aria-label': 'QR code for ' + url });
      window.dshQr.drawToCanvas(canvas, code, { scale, quiet });
      canvas.style.width = canvas.width / dpr + 'px';
      tile = h('div', { class: 'qr-tile' }, canvas);
    } catch (e) { tile = h('div', { class: 'note err' }, 'Could not draw the QR code: ' + e.message); }
  }
  openSheet(h('h3', {}, 'Open on your phone'),
    h('div', { class: 'note' }, tile ? 'Scan with the phone camera. You still log in with the passphrase.' : 'Open this address on your phone. You still log in with the passphrase.'),
    tile,
    h('div', { class: 'note url' }, url),
    h('div', { class: 'note' }, 'The address changes every time dsh-rc starts with --tunnel.'));
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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type !== 'open-session') return;
      if (d.sessionId) openSession(d.sessionId);
      else showList();
    });
  }
  try { S.describe = await rpc('host.describe', {}); } catch (e) {
    if (e.code === 'login') return; // on its way to the login page
    if (e.code === 'http-404' || e.code === 'http-401') return showUnsupportedDsh(e.code);
    toast('dsh not reachable: ' + e.message, 6000);
  }
  loadTunnelUrl().then((url) => { S.tunnelUrl = url; });
  connect();
  await loadSessions();
  if (location.hash) route();
})();
