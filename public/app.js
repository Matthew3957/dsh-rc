'use strict';
// dsh mobile: a phone-first chat client for a running `dsh web` server.
// Talks to the same-origin /api (HTTP RPC) and, for live data, WebSockets: /api/events.{mux,host} on
// dsh 0.1, /api/remote.mux on dsh 0.2 (public/dsh02.js maps it onto the same frames). Boot picks one.

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

// ---------- Motion ----------
// Section 5.5 of the design plan. The stylesheet carries the simple fades and every at-rest
// state; app.js drives the moves that must start from wherever a thing is right now (a sheet
// caught mid-rise or mid-drag, a view mid-push, a disclosure mid-fold) with the Web Animations
// API, on transform and opacity (a disclosure's height is the one layout exception the plan
// allows). Where that API is missing, or the user has asked to Reduce Motion, the change is
// instant or a short fade, which is also what the VM tests see.
const MOTION = {
  fast: 120, base: 220, slow: 320, push: 300, pop: 260, cross: 150, progress: 240,
  standard: 'cubic-bezier(0.2, 0, 0, 1)', emphasized: 'cubic-bezier(0.32, 0.72, 0, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)',
};
function reducedMotion() {
  try { return typeof matchMedia === 'function' && !!matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
const canAnimate = (el) => !!el && typeof el.animate === 'function';

// Toast: one at a time. It rises in over 180ms (style.css), and after its time fades out over
// 160ms before it is hidden. A new one replaces the old at once; there is no queue.
function toast(msg, ms = 2400) {
  const t = $('#toast');
  clearTimeout(toast._t); clearTimeout(toast._out);
  t.classList.remove('out');
  t.textContent = msg; t.hidden = false;
  toast._t = setTimeout(() => {
    t.classList.add('out');
    toast._out = setTimeout(() => { t.hidden = true; t.classList.remove('out'); }, 160);
  }, ms);
}

// Screen reader announcements (index.html #announce, a visually hidden polite live region): a
// turn that just ended and a decision that just arrived, said once. Nothing from history replay,
// nothing per token, and nothing the toast is already saying. Saying the same words twice in a
// row would be silent, so a repeat gets a trailing no-break space; the region empties itself
// after a while so a stale line is not found by someone reading the page.
let announceClear = null;
let announceArmed = false, announceLive = false; // see setConn and settleAnnouncements
// The pending decisions a dsh sends in the first moments after the socket opens are already on
// screen, not news. Let that opening burst land (a short settle, not a long silence), mark
// whatever is then waiting as seen, and turn live announcements on. A decision that arrives
// after that is announced once; a reconnect that re-sends it is silent.
const ANNOUNCE_GRACE_MS = 250; // let the opening burst land
const ANNOUNCE_BURST_MS = 75; // frames this close to the open are that burst, not news
const announced = new Set(); // decisions already announced (or already waiting at load)
const graceDecisions = new Map(); // key -> { item, at } for decisions during the settle
let announceStarted = 0;
const announcedTurns = new Set(); // sessionId:seq, so a replayed turn end is said once
function announce(msg) {
  const el = $('#announce');
  if (!el || !msg) return;
  el.textContent = el.textContent === msg ? msg + ' ' : msg;
  clearTimeout(announceClear);
  announceClear = setTimeout(() => { el.textContent = ''; }, 10000);
  if (announceClear && announceClear.unref) announceClear.unref();
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
// Shown when neither dsh 0.1's host.describe nor dsh 0.2's session/canOpenWorkspacePath answers.
// 401 from dsh itself (not dsh-rc's login) is dsh 0.2's token gate: dsh-rc has no launch token for it.
// A 404 is a /api that is not routed to dsh at all.
function showUnsupportedDsh(code) {
  const four04 = code === 'http-404';
  const card = h('div', { class: 'card api403' },
    h('h4', {}, four04 ? 'dsh-rc cannot find dsh here' : 'dsh wants its launch token'),
    h('div', { class: 'why' }, four04
      ? 'Neither the older dsh API (0.1.6 and earlier) nor the newer one (0.1.7 and later) answered. Check that this page\'s /api reaches dsh (the Tailscale Serve mount, ' +
        'or --dsh-url when dsh-rc runs as the front door).'
      : 'This dsh (0.1.7 or later) answers 401 until it has a signed cookie. Start dsh-rc with the token dsh printed at start ' +
        '(DSH_TOKEN, or --dsh-token-file), so its proxy can exchange it. See Compatibility in the README.'));
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
// The one HTTP call: dsh 0.1 method names with their payloads as they are, dsh 0.2 endpoints with {args}.
async function post(method, payload = {}, rpcId = rid()) {
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
// dsh 0.2: the adapter in dsh02.js answers the 0.1 method names the page uses.
let dsh2 = null;
const rpc = (method, payload = {}, rpcId = rid()) => (dsh2 ? dsh2.rpc(method, payload, rpcId) : post(method, payload, rpcId));
const remote = (method, args) => (dsh2 ? dsh2.remote(method, args) : post(method, { args }));
async function respond(rpcId, result) {
  if (dsh2) return dsh2.respond(rpcId, result);
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
  jobOut: new Map(),      // jobId -> {text, gap, streaming, error} while its output is observed
  jobOpen: new Set(),     // jobIds whose output pane is expanded
  subagents: new Map(),   // parentId -> {entries, parentAvailable, at}
  agentsLoading: new Set(), // parentIds whose subagent.list call is in flight
  dashOpen: new Set(),    // sessionIds whose live row has its jobs and subagents expanded
  model: new Map(),       // sessionId -> {provider, model} in use
  goalViews: new Map(),   // sessionId -> goals/get view (the armed state the projection lacks)
  prices: null,           // price overrides, read from localStorage once
  cur: null,
  conn: { mux: null, host: null, up: false, tries: 0, timer: null },
  describe: null,
  steer: false,
  images: [],
  commands: [],
  searchMode: false,      // the search field is open and its results stand in for the board
  boardScroll: 0,         // where the board was scrolled when search opened, for Cancel
  listLoaded: false,      // the first session.list answer is in; until then there is no empty state
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
  if (S.cur && S.cur.id === id) setNavTitle(t);
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
// The live row's elapsed is a running clock, not a log line: 0:07, 4:12, 1:04:12.
function fmtClock(ms) {
  const s = Math.max(0, Math.floor((typeof ms === 'number' && Number.isFinite(ms) ? ms : 0) / 1000));
  const hrs = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return hrs ? `${hrs}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
function md(text) {
  if (window.marked && window.DOMPurify) {
    try { return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true })); } catch {}
  }
  const d = document.createElement('div'); d.textContent = text;
  return (typeof d.innerHTML === 'string' ? d.innerHTML : String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).replace(/\n/g, '<br>');
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
// A tap on a link rendered from a message: links.js says where it points. Only
// the app page or another origin is followed. A same-origin path the model
// wrote (research/notes.md) would replace the standalone window with a URL the
// server has no page for, so show it and copy it instead.
function showDeadLink(a) {
  const href = String((a.getAttribute && a.getAttribute('href')) || a.href || '').trim();
  toast('Not a page here: ' + href, 4200);
  try {
    if (href && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(href).catch(() => {});
  } catch {}
}
function linkClicks() {
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !a.closest('.md')) return; // only links inside rendered markdown
    const links = window.dshLinks;
    const verdict = links ? links.classifyLink(a.getAttribute('href'), location.href) : { action: 'external' };
    if (verdict.action !== 'path') return;
    e.preventDefault();
    showDeadLink(a);
  });
}
function rootOf(id) { let x = id, n = 0; while (S.parent.has(x) && n++ < 10) x = S.parent.get(x); return x; }
function belongsToCur(id) { return S.cur && (id === S.cur.id || rootOf(id) === S.cur.id); }
// Read, search, web and todo rows read better with a label than the raw tool name.
const TOOL_LABEL = { read: 'Read', grep: 'Grep', glob: 'Glob', web_search: 'Web search', web_fetch: 'Fetch', todo_write: 'Todos' };
function prettyTool(name) {
  if (!name) return 'tool';
  if (TOOL_LABEL[name]) return TOOL_LABEL[name];
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
// The settled one-line state at the right edge of a read, search, web or todo card.
function cardStat(card) {
  if (!card) return '';
  switch (card.card) {
    case 'read': {
      const n = card.lines.length;
      const last = n ? card.lines[n - 1].number : card.offset;
      const whole = card.offset === 1 && n > 0 && last >= card.totalLines;
      const range = whole ? plural(n, 'line') : `lines ${card.offset}–${last} of ${card.totalLines}`;
      return card.lang ? `${range} · ${card.lang}` : range;
    }
    case 'search':
      if (card.shape === 'paths') return plural(card.total, 'path') + (card.truncated ? ' (capped)' : '');
      return plural(card.total, 'match', 'matches') + (card.files.length ? ` in ${plural(card.files.length, 'file')}` : '') + (card.truncated ? ' (capped)' : '');
    case 'web':
      if (card.kind === 'fetch') return `HTTP ${card.statusCode}` + (card.truncated ? ' · truncated' : '');
      return plural(card.sources.length, 'source') + (card.truncated ? ' (capped)' : '');
    case 'todos': {
      const done = card.todos.filter((x) => x.status === 'completed').length;
      const now = card.todos.filter((x) => x.status === 'in_progress').length;
      return `${done}/${card.todos.length} done` + (now ? ` · ${now} in progress` : '');
    }
    default: return '';
  }
}
// The numbered window a read card shows; bounded like the generic output.
const CARD_MAX_LINES = 1000;
function fillRead(detail, card) {
  if (!card.lines.length) { detail.append(h('div', { class: 'lbl' }, 'no lines')); return; }
  const width = String(card.totalLines).length;
  const rows = card.lines.slice(0, CARD_MAX_LINES).map((l) => `${String(l.number).padStart(width)}  ${l.text}`);
  if (card.lines.length > CARD_MAX_LINES) rows.push(`… ${plural(card.lines.length - CARD_MAX_LINES, 'more line')}`);
  detail.append(h('pre', {}, clip(rows.join('\n'), 20000)));
}
// grep's grouped matches, or glob's flat path list.
function fillSearch(detail, card) {
  if (card.shape === 'paths') {
    if (!card.paths.length) { detail.append(h('div', { class: 'lbl' }, 'no paths')); return; }
    const shown = card.paths.slice(0, CARD_MAX_LINES);
    detail.append(h('pre', {}, clip(shown.join('\n') + (card.paths.length > shown.length ? `\n… ${plural(card.paths.length - shown.length, 'more path')}` : ''), 20000)));
    return;
  }
  if (!card.files.length) { detail.append(h('div', { class: 'lbl' }, 'no matches')); return; }
  for (const f of card.files) {
    detail.append(h('div', { class: 'spath' }, relPath(f.path)));
    detail.append(h('pre', {}, clip(f.matches.map((m) => `${m.lineNumber}: ${m.line}`).join('\n'), 20000)));
  }
}
// web_search's citeable sources and answer, or web_fetch's fetched body.
function fillWeb(detail, card, t) {
  if (card.kind === 'search') {
    if (card.answer) { detail.append(h('div', { class: 'lbl' }, 'answer')); detail.append(mdNode(card.answer)); }
    if (card.sources.length) {
      detail.append(h('div', { class: 'lbl' }, plural(card.sources.length, 'source')));
      const list = h('div', { class: 'srcs' });
      for (const s of card.sources) {
        const row = h('div', { class: 'src' });
        if (s.title) row.append(h('span', { class: 'st' }, s.title), ' ');
        row.append(h('span', { class: 'su' }, s.url));
        if (s.snippet) row.append(h('div', { class: 'sn' }, s.snippet));
        list.append(row);
      }
      detail.append(list);
    } else if (!card.answer) detail.append(h('div', { class: 'lbl' }, 'no sources'));
    return;
  }
  if (t.result) { detail.append(h('div', { class: 'lbl' }, 'content')); detail.append(h('pre', {}, clip(t.result, 20000))); }
  else detail.append(h('div', { class: 'lbl' }, 'no content'));
}
// The whole list the agent last wrote, with a mark per state.
function fillTodos(detail, card) {
  if (!card.todos.length) { detail.append(h('div', { class: 'lbl' }, 'no tasks')); return; }
  const list = h('div', { class: 'todos' });
  for (const item of card.todos) {
    const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○';
    list.append(h('div', { class: 'todo ' + item.status },
      h('span', { class: 'tg', 'aria-hidden': 'true' }, mark),
      h('span', { class: 'tt' }, item.content)));
  }
  detail.append(list);
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);
const textOf = (content) => (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
// dsh's own token formatting, so the figures read like the web UI.
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
// Losing the socket shows a "Reconnecting…" banner under each view's bar; the list stays
// readable. When the socket returns the banner fades out, with no toast. #app carries the
// state as data-conn for the screenshot harness and anything else that needs to wait for it.
let connFade = null;
function setConn(up) {
  S.conn.up = up;
  $('#app').setAttribute('data-conn', up ? 'up' : 'down');
  // The decisions already waiting arrive in a burst just after the first connection: they are
  // on screen, not news. Announcements start once that burst has had a moment to land.
  if (up && !announceArmed) { announceArmed = true; announceStarted = Date.now(); setTimeout(settleAnnouncements, ANNOUNCE_GRACE_MS); }
  clearTimeout(connFade);
  const banners = [...document.querySelectorAll('.conn-banner')];
  if (!up) {
    for (const b of banners) { b.classList.remove('out'); b.hidden = false; }
    return;
  }
  const shown = banners.filter((b) => !b.hidden);
  if (!shown.length) return;
  for (const b of shown) b.classList.add('out');
  connFade = setTimeout(() => { for (const b of shown) { b.hidden = true; b.classList.remove('out'); } }, 240);
}
function openWS(path, onFrame) {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path);
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m && m.payload) onFrame(m.payload, m); };
  return ws;
}
function connect() {
  const c = S.conn;
  clearTimeout(c.timer);
  c.timer = null; // a stale id would make the next onDown think a reconnect is already scheduled
  if (dsh2) {
    S.approvals.clear(); S.questions.clear(); approvalLookups.clear(); renderPending();
    dsh2.connect();
    return;
  }
  for (const k of ['mux', 'host']) if (c[k]) { c[k].onclose = null; try { c[k].close(); } catch {} }
  S.approvals.clear(); S.questions.clear(); approvalLookups.clear(); renderPending();
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
// dsh 0.2: one socket carries every feed. It going away is the same reconnect as dsh 0.1's.
function startDsh2() {
  const c = S.conn;
  dsh2 = window.dsh02.createClient({
    transport: post,
    wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + window.dsh02.MUX_PATH,
    onFrame: (kind, payload, env) => (kind === 'host' ? onHost(payload) : onMux(payload, env)),
    onHome: (home) => { if (home) S.describe = { ...(S.describe || {}), home }; },
    onUp: () => { c.tries = 0; setConn(true); if (S.cur) loadHistory(); if (window.dshSchedulesUI) window.dshSchedulesUI.probe(); },
    onDown: () => {
      setConn(false);
      if (c.timer) return;
      const wait = Math.min(10000, 800 * 2 ** c.tries++);
      c.timer = setTimeout(() => { c.timer = null; connect(); }, wait);
    },
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const c = S.conn;
  const dead = dsh2 ? !dsh2.isOpen() : !c.mux || c.mux.readyState > 1 || !c.host || c.host.readyState > 1;
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
        } else if (ev.type === 'turn/end') {
          S.running.set(p.sessionId, false); S.turnStart.delete(p.sessionId);
          noteTurnEnd(p.sessionId, ev.data && ev.data.reason, ev.time);
          if (!$('#listView').hidden && !S.searchMode) renderList();
        }
      }
      if (S.cur && p.sessionId === S.cur.id) ingest(p);
      // The open session's turn end is announced by applyLive, after its receipt is drawn. On
      // the board there is no receipt, so its live row change is announced directly (deduped
      // by sequence, because a reconnect can replay the frame).
      if (ev && ev.type === 'turn/end' && !S.cur) announceTurnEnd(p.sessionId, ev);
      if (ev && ev.type === 'session/title') setTitle(p.sessionId, ev.data && ev.data.title);
      if (ev && (ev.type === 'turn/start' || ev.type === 'turn/end')) scheduleDashboard();
      break;
    }
    case 'session/subscribed':
      if (S.cur && p.sessionId === S.cur.id && !S.cur.loading && p.lastSeq > S.cur.lastSeq) loadHistory();
      break;
    case 'approval/requested': {
      const prev = S.approvals.get(p.approvalId);
      const a = { ...p, rpcId: env.rpcId, seenAt: (prev && prev.seenAt) || Date.now() };
      S.approvals.set(p.approvalId, a);
      lookupApprovalArgs(a).catch(() => {}); // marks a lookup in flight before the card is drawn
      renderPending(); badge();
      announceDecision('a:' + p.approvalId, { kind: 'approve', a });
      break;
    }
    case 'approval/resolved':
      S.approvals.delete(p.approvalId); approvalLookups.delete(p.approvalId); renderPending(); badge();
      break;
    case 'question/requested':
      S.questions.set(env.rpcId, { ...p, rpcId: env.rpcId, seenAt: (S.questions.get(env.rpcId) || {}).seenAt || Date.now() }); renderPending(); badge();
      announceDecision('q:' + env.rpcId, { kind: 'ask', q: S.questions.get(env.rpcId) });
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
      pruneJobOutput();
      scheduleDashboard();
      break;
    case 'job/output':
      // One observed job's live output and terminal status (dsh 0.2, on demand).
      handleJobOutput(p);
      break;
    case 'session/projection': {
      if (p.key === 'title') setTitle(p.sessionId, titleFromProjection(p.value));
      const seq = typeof p.seq === 'number' ? p.seq : -1;
      if (setProjection(p.sessionId, p.key, p.value, seq)) {
        if (S.cur && p.sessionId === S.cur.id) {
          renderStatusLine();
          if (p.key === 'goal') { renderGoalBar(); refreshGoal(p.sessionId); }
        }
        if (DASH_KEYS.has(p.key)) scheduleDashboard();
        if (p.key === 'subagentCatalog') refreshAgentTree(p.sessionId);
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
    case 'host/schedules-changed':
      if (window.dshSchedulesUI) window.dshSchedulesUI.changed();
      break;
    case 'host/session-status':
      if (p.running && !S.running.get(p.sessionId)) S.turnStart.set(p.sessionId, Date.now());
      if (!p.running) S.turnStart.delete(p.sessionId);
      S.running.set(p.sessionId, !!p.running);
      if (S.parent.has(p.sessionId)) refreshAgentTree(p.sessionId);
      if (S.cur && p.sessionId === S.cur.id) renderRunning();
      if (!$('#listView').hidden && !S.searchMode) renderList();
      scheduleDashboard();
      break;
    case 'host/session-added':
      // Only subagents fold into their parent. A fork also carries parentSessionId (lineage), but it
      // is a session of its own and belongs in the list.
      if (p.parentSessionId && p.origin === 'subagent') { S.parent.set(p.sessionId, p.parentSessionId); refreshAgentTree(p.sessionId); }
      if (!p.blank && p.origin !== 'subagent' && !$('#listView').hidden) loadSessions();
      scheduleDashboard();
      break;
    case 'host/session-removed':
      S.jobs.delete(p.sessionId); S.subagents.delete(p.sessionId); S.dashOpen.delete(p.sessionId);
      pruneJobOutput();
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
      else if (p.sessionId) { readState.failed[rootOf(p.sessionId)] = Date.now(); saveReadState(); if (!$('#listView').hidden && !S.searchMode) renderList(); }
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
    watchDashJobs();
    saveTitles();
    if (!readState.seeded) {
      // First run on this device: everything so far counts as read.
      for (const x of S.sessions) readState.seen[x.sessionId] = x.updatedAt || Date.now();
      readState.seeded = true; readState.seededAt = Date.now(); saveReadState();
    }
    S.listLoaded = true;
    if (!S.searchMode) renderList();
    renderDashboard();
    fillTitles();
    checkUnreadTails().catch(() => {});
  } catch (e) {
    $('#sessions').replaceChildren(h('div', { class: 'empty-state' },
      h('p', { class: 'empty-title' }, 'Could not load sessions'),
      h('p', { class: 'empty-body' }, e.message)));
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
// ----- read state and failed turns (per device) -----
// dsh keeps neither, so the page does: `seen` is when each session was last looked at,
// `failed` when its latest turn ended in an error the user has not opened yet. The
// first run seeds `seen` with everything, so an old history does not arrive unread.
const readState = (() => {
  const load = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  const seen = load('dshm.seen'), failed = load('dshm.failed') || {};
  let seededAt = 0; try { seededAt = Number(localStorage.getItem('dshm.seededAt')) || 0; } catch {}
  return { seen: seen || {}, seeded: !!seen, seededAt, failed };
})();
function saveReadState() {
  try {
    // Keep the newest 500 of each so storage stays small.
    const trim = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 500));
    const kept = trim(readState.seen);
    if (Object.keys(kept).length < Object.keys(readState.seen).length) {
      // Rows dropped from `seen` were all seen no later than the oldest one kept: move the
      // seed mark up to it, so a trimmed row reads as read unless it changed after that.
      readState.seededAt = Math.max(readState.seededAt || 0, Math.min(...Object.values(kept)));
      readState.seen = kept;
    }
    localStorage.setItem('dshm.seen', JSON.stringify(kept));
    localStorage.setItem('dshm.failed', JSON.stringify(trim(readState.failed)));
    if (readState.seededAt) localStorage.setItem('dshm.seededAt', String(readState.seededAt));
  } catch {}
}
function sessionUpdatedAt(id) { const s = S.sessions.find((x) => x.sessionId === id); return (s && s.updatedAt) || 0; }
function markSeen(id) {
  if (!id) return;
  // Server time (the session's own updatedAt) when known, so a phone clock running ahead
  // or behind the laptop's cannot hide or invent unread sessions.
  readState.seen[id] = sessionUpdatedAt(id) || Date.now();
  delete readState.failed[id];
  saveReadState();
}
function isUnread(id) {
  if (S.cur && S.cur.id === id) return false;
  const seen = readState.seen[id];
  // No entry: new since this device first looked (or trimmed from storage). Only count
  // it as unread if it changed after the first-run seed, so trimmed old rows stay read.
  if (seen == null) return readState.seeded && sessionUpdatedAt(id) > readState.seededAt;
  return sessionUpdatedAt(id) > seen + 1000;
}
function noteTurnEnd(sessionId, reason, time) {
  const id = rootOf(sessionId);
  const row = S.sessions.find((x) => x.sessionId === id);
  if (row) row.updatedAt = Math.max(row.updatedAt || 0, typeof time === 'number' ? time : Date.now());
  if (S.cur && S.cur.id === id && document.visibilityState === 'visible') { markSeen(id); return; }
  if (reason && reason.kind === 'error') readState.failed[id] = Date.now();
  else if (id === sessionId) delete readState.failed[id]; // a later good turn of the session itself clears it
  saveReadState();
}
// A turn that just ended, for a screen reader. In the open session it is the receipt's own
// verdict and counts ("Turn passed, 2 files, 1 command"); on the board it is the session and the
// verdict. A subagent's turn is part of its parent's and is not announced, and neither is
// another session's while a chat is open: that would talk over the conversation in front of
// the user. History replay never reaches here; this runs only for a live turn/end frame.
function announceTurnEnd(sessionId, ev) {
  if (!sessionId || rootOf(sessionId) !== sessionId) return;
  const stamp = ev && ev.seq != null ? 's' + ev.seq : ev && ev.time != null ? 't' + ev.time : '';
  if (stamp) {
    const key = sessionId + ':' + stamp;
    if (announcedTurns.has(key)) return;
    announcedTurns.add(key);
    if (announcedTurns.size > 500) announcedTurns.delete(announcedTurns.values().next().value);
  }
  const here = !!S.cur && S.cur.id === sessionId;
  if (S.cur && !here) return;
  const reason = (ev && ev.data && ev.data.reason) || {};
  if (here) {
    const T = R.turns[R.turns.length - 1];
    const facts = T && T.done && T.endEv === ev ? receiptFacts(T) : null;
    const outcome = facts ? facts.outcome : outcomeOf(reason);
    announce(['Turn ' + outcome].concat(facts ? facts.counts : []).join(', '));
    return;
  }
  // Without the turn's receipt only failed and stopped are certain from the reason; a
  // "completed" turn may still have a failing command, so it is not called passed here.
  const title = S.titles.get(sessionId) || basename(sessionMeta(sessionId).cwd) || 'A session';
  const outcome = outcomeOf(reason);
  announce(`${title}: turn ${outcome === 'passed' ? 'finished' : outcome}`);
}
// The verdict from a turn/end reason alone, when no receipt is drawn for it (the same words
// summarizeTurn gives the receipt).
function outcomeOf(reason) {
  const kind = reason && reason.kind;
  if (kind === 'error' || kind === 'blocked') return 'failed';
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'max-tokens') return 'stopped';
  return 'passed';
}
// A newly arrived approval or question, once, with the tool and its command or the question's
// first line. The decision card already on screen holds the detail. Anything that was waiting
// when the page connected is remembered silently, so a reconnect that re-sends it stays quiet.
function announceDecision(key, item) {
  if (announced.has(key)) return;
  // During the opening settle, remember the request but do not mark it seen yet. Whatever is
  // still waiting when the settle ends is the burst that was already on screen; anything that
  // arrives after that is news.
  if (!announceLive) { if (item && !graceDecisions.has(key)) graceDecisions.set(key, { item, at: Date.now() }); return; }
  rememberDecision(key);
  if (!item) return;
  const sessionId = item.kind === 'approve' ? item.a.sessionId : item.q && item.q.sessionId;
  const root = rootOf(sessionId);
  const where = S.cur && S.cur.id === root ? '' : ` in ${S.titles.get(root) || basename(sessionMeta(root).cwd) || 'another session'}`;
  if (item.kind === 'approve') {
    const a = item.a;
    const raw = approvalArgs(a);
    const arg = raw != null ? firstText(toolSummary(raw, null, a.toolName)) : '';
    announce(`Approval needed for ${prettyTool(a.toolName)}${where}${arg ? ': ' + arg.slice(0, 120) : ''}`);
    return;
  }
  const q = item.q || {};
  if (window.dshReview && window.dshReview.planReviewOf(q.questions)) { announce(`Plan ready for review${where}`); return; }
  const first = (q.questions || [])[0];
  const text = firstText(first && (first.question || first.header));
  announce(`Question${where}${text ? ': ' + text.slice(0, 160) : ''}`);
}
function rememberDecision(key) {
  announced.add(key);
  if (announced.size > 500) announced.delete(announced.values().next().value);
}
function settleAnnouncements() {
  // Mark the opening burst silently, then let the next request speak. A request that arrived
  // after the burst but during the settle is news too, so it is held back, not swallowed: once
  // the burst is marked, it is announced. A reconnect does not re-arm this: the ids stay in
  // `announced`, and the original frames are not replayed as new.
  const late = [];
  for (const [key, rec] of graceDecisions) {
    const item = rec && rec.item;
    const still = item && (item.kind === 'approve' ? S.approvals.has(item.a.approvalId) : S.questions.has(item.q && item.q.rpcId));
    if (still && rec.at - announceStarted >= ANNOUNCE_BURST_MS) late.push([key, item]);
  }
  for (const a of S.approvals.values()) rememberDecision('a:' + a.approvalId);
  for (const q of S.questions.values()) rememberDecision('q:' + q.rpcId);
  for (const key of graceDecisions.keys()) rememberDecision(key);
  graceDecisions.clear();
  announceLive = true;
  for (const [key, item] of late) { announced.delete(key); announceDecision(key, item); }
}

// Sessions that changed while the page was closed: read the tail of a few to learn
// whether their last turn failed. Capped, and only for unread rows, so the list stays cheap.
let checkingTails = false;
const tailChecked = new Map(); // sessionId -> updatedAt already checked, so a list reload does not re-fetch
async function checkUnreadTails() {
  if (checkingTails) return; checkingTails = true;
  try {
    const todo = S.sessions.filter((s) => isUnread(s.sessionId) && !S.running.get(s.sessionId) && readState.failed[s.sessionId] == null
      && (tailChecked.get(s.sessionId) || 0) < (s.updatedAt || 0)).slice(0, 10);
    let changed = false;
    for (const s of todo) {
      tailChecked.set(s.sessionId, s.updatedAt || 0);
      try {
        const v = await rpc('session.history', { sessionId: s.sessionId, maxMessages: 1 });
        const ends = (v.events || []).map((f) => f.event).filter((e) => e && e.type === 'turn/end');
        const last = ends[ends.length - 1];
        if (last && last.data && last.data.reason && last.data.reason.kind === 'error') { readState.failed[s.sessionId] = last.time || Date.now(); changed = true; }
      } catch {}
    }
    if (changed) { saveReadState(); if (!$('#listView').hidden && !S.searchMode) renderList(); }
  } finally { checkingTails = false; }
}
// A row's one state, most urgent first.
function pendingKind(id) {
  for (const a of S.approvals.values()) if (rootOf(a.sessionId) === id) return 'approve';
  for (const q of S.questions.values()) if (rootOf(q.sessionId) === id) return 'ask';
  return null;
}
function sessState(id) {
  const pend = pendingKind(id);
  if (pend) return pend === 'approve' ? 'wait approve' : 'wait ask';
  // Working outranks failed: a new turn is under way, and its end decides the state.
  if (sessionIsWorking(id)) return 'run';
  if (readState.failed[id] != null && !(S.cur && S.cur.id === id)) return 'error';
  return isUnread(id) ? 'unread' : 'idle';
}
// ---------- Status glyphs ----------
// One 16px vocabulary for the session list, tools, jobs and subagents, drawn by style.css with
// the same shape in every theme. Callers name what they know; these maps turn it into a glyph.
const GLYPH_STATES = ['idle', 'run', 'approve', 'ask', 'unread', 'done', 'failed', 'stopping', 'stopped'];
// extra: role classes the layout and tests hook on (run-dot, jdot, adot, bullet).
function statusGlyph(state, extra) {
  const g = GLYPH_STATES.includes(state) ? state : 'idle';
  return h('span', { class: 'glyph ' + g + (extra ? ' ' + extra : ''), 'aria-hidden': 'true' });
}
// A session row's state (sessState) to its glyph.
const SESSION_GLYPH = { 'wait approve': 'approve', 'wait ask': 'ask', run: 'run', error: 'failed', unread: 'unread', idle: 'idle' };
function glyphEl(state) { return statusGlyph(SESSION_GLYPH[state] || 'idle'); }
// A background job's status (dsh's JobView) to its glyph: killed and cancelled ended by request.
function jobGlyph(status) {
  return { running: 'run', completed: 'done', failed: 'failed', killed: 'stopped', cancelled: 'stopped', stopping: 'stopping' }[status] || 'idle';
}
// A plugin or scheduled prompt's dot: on is healthy, late wants attention, off is switched off.
function itemGlyph(st) {
  return { on: 'done', failed: 'failed', late: 'stopping', off: 'stopped' }[st] || 'idle';
}
// ---------- Sessions: the board ----------
// One list in the order attention deserves: Needs you, Running now, Unread, Today, Earlier
// (Yesterday, Previous 7 days, Older). Each session appears once, in the first section that
// claims it. The sections are the filter, so there is no other.
// The first non-blank line of a summary, trimmed.
const firstText = (text) => String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
// An approval frame names the tool and call, not its arguments. The call is in the session's
// history, so read that once per approval and keep the argument for the Needs you summary.
const approvalLookups = new Set();
// The drawn call is only this approval's when its session is the one on screen; R.tools
// outlives the chat view, so an id from another session must not supply the argument.
function drawnCallArgs(a) {
  if (!S.cur || !a.callId) return null;
  if (a.sessionId !== S.cur.id && rootOf(a.sessionId) !== S.cur.id) return null;
  const t = R.tools.get(a.callId);
  return t && t.args != null ? t.args : null;
}
// The same argument also fills the session's approval card, which repaints when it lands, so the
// command is on screen whenever dsh has it.
async function lookupApprovalArgs(a) {
  if (!a || !a.approvalId || !a.callId || a.args != null || a.input != null) return;
  const drawn = drawnCallArgs(a);
  if (drawn != null) { a.args = drawn; return; }
  if (approvalLookups.has(a.approvalId)) return;
  approvalLookups.add(a.approvalId);
  a.lookup = 'pending';
  const settle = (state) => {
    if (S.approvals.get(a.approvalId) !== a) return; // answered or replaced meanwhile
    a.lookup = state;
    if (S.cur && belongsToCur(a.sessionId)) renderPending();
  };
  try {
    const v = await rpc('session.history', { sessionId: a.sessionId, maxMessages: 24 });
    const call = (v.events || []).map((f) => f.event)
      .find((e) => e && e.type === 'tool/call' && e.data && e.data.callId === a.callId);
    if (!call || S.approvals.get(a.approvalId) !== a) { settle('missing'); return; }
    a.args = call.data.arguments;
    if (typeof call.time === 'number' && call.time <= Date.now()) a.since = call.time; // waiting since the call, not since this page saw it
    settle('done');
    if (!$('#listView').hidden && !S.searchMode) renderList(); else paintNeedsYou();
  } catch { settle('missing'); } // a history read is a nicety; the reason still answers the row
}
// The sessions waiting on an approval or a question, by root session, in the order they asked.
function waitingSessions() {
  const out = new Map();
  const add = (id, item) => { const root = rootOf(id); if (!out.has(root)) out.set(root, []); out.get(root).push(item); };
  for (const a of S.approvals.values()) add(a.sessionId, { kind: 'approve', a });
  for (const q of S.questions.values()) add(q.sessionId, { kind: 'ask', q });
  return out;
}
// One line of what is being asked, for a Needs you row. The decision itself happens in the
// session: the list never offers Allow or Deny.
function askSummary(item) {
  if (item.kind === 'approve') {
    const a = item.a;
    const tool = prettyTool(a.toolName);
    // The argument is known when the frame carries it or the session's call is already drawn.
    const raw = a.args != null ? a.args : a.input != null ? a.input : drawnCallArgs(a);
    const arg = raw != null ? firstText(toolSummary(raw, null, a.toolName)) : '';
    if (arg) return `Allow ${tool}: ${arg}`;
    const why = firstText(a.reason);
    return why ? `Allow ${tool}? ${why}` : `Allow ${tool}?`;
  }
  const q = item.q;
  if (window.dshReview && window.dshReview.planReviewOf(q.questions)) return 'Approve the plan';
  const first = (q.questions || [])[0];
  return firstText(first && (first.question || first.header)) || 'Question for you';
}
// Calendar buckets for the date sections, by the device's own day boundaries.
function dateGroup(ms, now = Date.now()) {
  if (typeof ms !== 'number' || !ms) return 'older';
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  day.setDate(day.getDate() - 1);
  const yesterday = day.getTime();
  day.setDate(day.getDate() - 6);
  const week = day.getTime();
  return ms >= today ? 'today' : ms >= yesterday ? 'yesterday' : ms >= week ? 'week' : 'older';
}
const DATE_GROUPS = [['yesterday', 'Yesterday'], ['week', 'Previous 7 days'], ['older', 'Older']];
// A row: a status glyph, the title, one 13px line and a chevron. The whole row is one button.
function boardRow(id, { title, untitled, glyph, line, lineClass, label, extra }) {
  return h('li', { class: 'sess' + (extra ? ' ' + extra : ''), 'data-session': id },
    h('button', { class: 'sess-hit', type: 'button', 'aria-label': label, onclick: () => openSession(id) },
      glyph,
      h('span', { class: 'main' },
        h('span', { class: 't' + (untitled ? ' untitled' : '') }, title),
        h('span', { class: lineClass || 'm' }, ...[].concat(line))),
      h('span', { class: 'sess-chev', 'aria-hidden': 'true' })));
}
// A history row (Unread, Today, Earlier, search): folder and relative time, with "Failed" in
// red when the last turn failed. A search hit shows its two-line snippet instead.
function sessRow(s, snippet) {
  const id = s.sessionId;
  const t = S.titles.get(id);
  const state = sessState(id);
  const folder = basename(s.cwd);
  const title = t || folder || 'Untitled';
  const meta = [folder, ago(s.updatedAt)].filter(Boolean).join(' · ');
  const failed = state === 'error';
  const unread = state === 'unread' || (failed && isUnread(id));
  // A search hit that is just the title would read twice; only a distinct excerpt is a snippet.
  const snip = snippet && snippet.trim() && snippet.trim() !== title ? snippet : null;
  const word = { 'wait approve': 'Needs approval', 'wait ask': 'Question for you', run: 'Working', error: 'Failed' }[state];
  const line = snip ? [snip]
    : failed ? [h('span', { class: 'failed-word' }, 'Failed'), meta ? ' · ' + meta : '']
    : word ? [word + (meta ? ' · ' + meta : '')] : [meta];
  return boardRow(id, {
    title, untitled: !t,
    // Unread is a section as well as a glyph: a failed unread row keeps the accent dot and
    // says "Failed" in red, so neither cue is colour alone.
    glyph: glyphEl(unread ? 'unread' : state), line, lineClass: snip ? 'snip' : 'm',
    label: [title, word || (unread ? 'Unread' : ''), snip ? '' : meta].filter(Boolean).join(', '),
    extra: state + (unread && state !== 'unread' ? ' unread' : ''),
  });
}
// A Needs you row: the glyph says approval or question, the mono line says what is asked.
function needsRow(id, items) {
  const s = sessionMeta(id);
  const t = S.titles.get(id);
  const title = t || basename(s.cwd) || 'Untitled';
  const kind = items[0].kind;
  const ask = askSummary(items[0]) + (items.length > 1 ? ` (+${items.length - 1} more)` : '');
  return boardRow(id, {
    title, untitled: !t, glyph: statusGlyph(kind),
    line: ask, lineClass: 'ask-sum',
    label: `${title}, ${kind === 'approve' ? 'needs approval' : 'question for you'}: ${ask}`,
    extra: 'wait ' + kind,
  });
}
const secHead = (id, label, count) => h('h2', { class: 'sec-head', id },
  h('span', { class: 'sec-label' }, label), count != null ? [' ', h('span', { class: 'sec-count' }, String(count))] : null);
// The sessions Running now shows: the working ones that are not waiting on the user.
function runningSessions(waiting = waitingSessions()) {
  return activeSessions().filter((s) => !waiting.has(s.sessionId));
}
let boardKey = null; // the Running now ids the other sections were last drawn without
function renderList() {
  const waiting = waitingSessions();
  const running = runningSessions(waiting);
  boardKey = running.map((s) => s.sessionId).join('\u0000');
  paintNeedsYou(waiting);
  const taken = new Set([...waiting.keys(), ...running.map((s) => s.sessionId)]);
  const rest = S.sessions.filter((s) => !taken.has(s.sessionId));
  const unread = rest.filter((s) => isUnread(s.sessionId));
  const dated = rest.filter((s) => !isUnread(s.sessionId)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const shown = dated.slice(0, S.shown);
  const list = (rows) => h('ul', { class: 'sess-list' }, rows.map((s) => sessRow(s)));
  const secs = [];
  if (unread.length) secs.push(h('section', { class: 'board-sec', 'aria-labelledby': 'unreadHead' }, secHead('unreadHead', 'Unread', unread.length), list(unread)));
  const today = shown.filter((s) => dateGroup(s.updatedAt) === 'today');
  if (today.length) secs.push(h('section', { class: 'board-sec', 'aria-labelledby': 'todayHead' }, secHead('todayHead', 'Today'), list(today)));
  const earlier = DATE_GROUPS.map(([key, label]) => [label, shown.filter((s) => dateGroup(s.updatedAt) === key)]).filter(([, rows]) => rows.length);
  if (earlier.length) {
    secs.push(h('section', { class: 'board-sec', 'aria-labelledby': 'earlierHead' }, secHead('earlierHead', 'Earlier'),
      earlier.flatMap(([label, rows]) => [h('h3', { class: 'sec-sub' }, label), list(rows)])));
  }
  if (S.listLoaded && !S.sessions.length && !waiting.size) secs.push(emptyBoard());
  $('#sessions').replaceChildren(...secs);
  $('#moreBtn').hidden = dated.length <= S.shown;
  renderDashboard();
}
// Empty: one line glyph, one title, one sentence. The bottom bar holds the action.
function emptyBoard() {
  return h('div', { class: 'empty-state' },
    h('span', { class: 'empty-glyph', 'aria-hidden': 'true' }),
    h('p', { class: 'empty-title' }, 'No sessions yet'),
    h('p', { class: 'empty-body' }, 'Start one from your laptop, or tap New session.'));
}
// Approvals and questions move a session into or out of Needs you.
function badge() {
  if (!$('#listView').hidden && !S.searchMode) renderList(); else paintNeedsYou();
}
function paintNeedsYou(waiting = waitingSessions()) {
  const box = $('#pendingGlobal');
  if (!waiting.size) { box.replaceChildren(); box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren(secHead('needsHead', 'Needs you', waiting.size),
    h('ul', { class: 'sess-list' }, [...waiting].map(([id, items]) => needsRow(id, items))));
}
// Search opens in the bar and takes the board's place; Cancel puts the board back where it was.
let searchT = null;
let searchSeq = 0;
const SEARCH_HINT = 'Search titles and messages in every session.';
const searchHint = (text) => h('li', { class: 'search-hint' }, text);
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  const seq = ++searchSeq;
  if (!q) { $('#searchResults').replaceChildren(searchHint(SEARCH_HINT)); return; }
  searchT = setTimeout(async () => {
    try {
      const v = await rpc('session.search', { query: q });
      if (seq !== searchSeq || !S.searchMode) return; // a later keystroke or a Cancel won
      const byId = new Map(S.sessions.map((s) => [s.sessionId, s]));
      const rows = (v.items || []).map((it) => sessRow(byId.get(it.sessionId) || { sessionId: it.sessionId }, it.snippet));
      $('#searchResults').replaceChildren(...(rows.length ? rows : [searchHint('No matches')]));
    } catch (err) { if (seq === searchSeq && S.searchMode) toast('Search failed: ' + err.message); }
  }, 300);
});
function openSearch() {
  if (S.searchMode) { $('#q').focus(); return; }
  const scroller = $('#listScroll');
  S.searchMode = true;
  S.boardScroll = scroller.scrollTop;
  $('#listView').classList.add('searching');
  $('#searchRow').hidden = false;
  $('#searchBtn').setAttribute('aria-expanded', 'true');
  $('#searchResults').replaceChildren(searchHint(SEARCH_HINT));
  $('#searchResults').hidden = false;
  scroller.scrollTop = 0;
  $('#q').focus();
}
function closeSearch() {
  clearTimeout(searchT); searchSeq++;
  $('#q').value = '';
  $('#searchRow').hidden = true;
  $('#searchBtn').setAttribute('aria-expanded', 'false');
  $('#searchResults').hidden = true;
  $('#searchResults').replaceChildren();
  $('#listView').classList.remove('searching');
  if (!S.searchMode) return;
  S.searchMode = false;
  renderList();
  $('#listScroll').scrollTop = S.boardScroll || 0;
  $('#searchBtn').focus();
}
$('#searchBtn').onclick = openSearch;
$('#searchClose').onclick = closeSearch;
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
// The board loads the next page itself near the end; the quiet button is the fallback.
function loadMore() {
  if ($('#moreBtn').hidden || S.searchMode) return;
  S.shown += 40; renderList(); fillTitles();
}
$('#moreBtn').onclick = loadMore;
if (typeof IntersectionObserver === 'function') {
  new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); },
    { root: $('#listScroll'), rootMargin: '0px 0px 480px 0px' }).observe($('#moreBtn'));
  // The compact nav title shows only once the large title has gone under the bar.
  new IntersectionObserver((entries) => {
    for (const e of entries) $('#listNav').classList.toggle('titled', !e.isIntersecting);
  }, { root: $('#listScroll') }).observe($('#listLargeTitle'));
}

// ---------- Renderer ----------
// A turn is an answer plus its activity. The model below is built only from events,
// so replaying history and applying live frames go through the same path and group
// the same way. Activity collapses into a receipt when the turn ends; while a turn
// runs, the last three rows stay visible with a quiet disclosure for the rest.
const R = {
  tools: new Map(),  // callId -> tool model; .el is the details row the tests and revealTool use
  fin: new Set(),    // "turn:step" final messages already rendered
  turns: [],
  turn: null,

  reset() {
    this.tools.clear();
    this.fin = new Set();
    this.turns = [];
    this.turn = null;
    $('#msgs').replaceChildren();
  },
  add(el) { $('#msgs').append(el); return el; },
  note(text, kind = '') { const el = this.add(h('div', { class: 'note ' + kind }, text)); stick(); return el; },

  startTurn(sawStart, time) {
    const T = {
      sawStart: !!sawStart,
      startedAt: typeof time === 'number' ? time : null,
      endedAt: null,
      reason: null,
      why: '',
      items: [],       // text, reasoning and tool rows in event order
      tools: [],
      liveKey: null,
      liveText: '',
      liveThink: '',
      liveNarration: '',
      showAll: false,
      done: false,
      el: null, // created at the first painted step, so a user message logged after turn/start stays above it
    };
    this.turns.push(T);
    this.turn = T;
    return T;
  },
  ensureTurn(time) { return this.turn || this.startTurn(false, time); },
  addTool(T, t) {
    if (!T.tools.includes(t)) T.tools.push(t);
    if (!T.items.some((i) => i.kind === 'tool' && i.tool === t)) T.items.push({ kind: 'tool', tool: t });
  },

  apply(frame) {
    const ev = frame.event; if (!ev) return;
    const d = ev.data || {};
    switch (ev.type) {
      case 'turn/start':
        this.startTurn(true, ev.time);
        return;
      case 'user/message': {
        const src = d.source || {};
        if (src.kind !== 'user') return;
        if (src.rpcId) { const p = document.querySelector(`.user.pending[data-rpc="${CSS.escape(src.rpcId)}"]`); if (p) p.remove(); }
        const imgs = (d.content || []).filter((b) => b.type === 'image');
        const body = (d.content || []).filter((b) => b.type !== 'image').map((b) => b.text || '').join('');
        const attachments = imgs.map((b) => {
          let src = b.url || b.image || '';
          if (b.data) { const data = String(b.data); src = data.startsWith('data:') ? data : `data:${b.mediaType || 'image/png'};base64,${data}`; }
          return src ? h('img', { class: 'transcript-image', src, alt: 'Image attachment' }) : h('span', { class: 'img' }, b.text || 'Image attachment');
        });
        this.add(h('div', { class: 'user' }, body, ...attachments));
        return;
      }
      case 'assistant/chunk': this.chunk(d); return;
      case 'assistant/message': this.final(d); return;
      case 'tool/call': {
        const T = this.ensureTurn(ev.time);
        const t = this.tool(d.callId, d.name, d.arguments);
        this.addTool(T, t);
        // dsh 0.2 sends no view: rebuild it from the arguments, as dsh's own web client does.
        const v = (frame.view && frame.view.view) || (dsh2 ? window.dsh02.toolCallView(d.name, d.arguments) : null);
        if (v) { t.view = v; this.paintTool(t); }
        this.paintTurn(T);
        return;
      }
      case 'tool/result': {
        const T = this.ensureTurn(ev.time);
        const m = d.message || {};
        // dsh 0.1 nests the result in a tool-result block; dsh 0.2 puts its text blocks, isError and
        // toolCallId on the tool message itself (seen on the wire, 0.2.0-rc.2).
        const block = (m.content || []).find((b) => b.type === 'tool-result')
          || { toolCallId: m.toolCallId, isError: m.isError, content: m.content || [] };
        const callId = (m.source && m.source.callId) || block.toolCallId;
        const t = this.tool(callId);
        t.done = true;
        t.isError = !!block.isError || !!d.error;
        t.result = textOf(block.content) || (d.error && (d.error.message || String(d.error))) || '';
        // dsh 0.2: from the call, the result text and the tool's `meta` (a write or edit's applied hunks).
        const rv = (frame.view && frame.view.view) || (dsh2 ? window.dsh02.toolResultView(t.name, t.args, { content: block.content, isError: t.isError, meta: d.meta }) : null);
        if (rv) t.rview = rv;
        this.addTool(T, t);
        this.paintTool(t);
        this.paintTurn(T);
        return;
      }
      case 'turn/end': this.endTurn(ev); return;
      case 'command/done':
        if (d.text) this.note(d.text, d.kind === 'error' ? 'err' : 'cmd');
        return;
      case 'session/title':
        if (S.cur) setTitle(S.cur.id, d.title);
        return;
      case 'compaction/end':
      case 'compaction/done':
        this.note('Context compacted');
        return;
    }
  },

  key(d) { return `${d.turn}:${d.step}`; },
  chunk(d) {
    const T = this.ensureTurn();
    const k = this.key(d);
    if (this.fin.has(k)) return;
    if (T.liveKey !== k) { T.liveKey = k; T.liveText = ''; T.liveThink = ''; }
    const c = d.chunk || {};
    switch (c.type) {
      case 'text-delta':
        T.liveText += c.text || '';
        break;
      case 'reasoning-delta':
        T.liveThink += c.text || '';
        break;
      case 'tool-call-delta':
        if (c.id) {
          const t = this.tool(c.id, c.name, undefined);
          this.addTool(T, t);
          // The text before a tool call is narration, not the answer. Keep it visible
          // in the live activity; the final message replaces this whole step.
          if (T.liveText) { T.liveNarration = T.liveText; T.liveText = ''; }
        }
        break;
    }
    paintTurnSoon(T);
  },
  final(d) {
    const T = this.ensureTurn();
    const k = this.key(d);
    this.fin.add(k);
    const msg = d.message || {};
    T.liveText = ''; T.liveThink = ''; T.liveNarration = '';
    for (const b of msg.content || []) {
      if (b.type === 'text' && b.text) T.items.push({ kind: 'text', text: b.text });
      else if (b.type === 'reasoning' && b.text) T.items.push({ kind: 'reasoning', text: b.text });
      else if (b.type === 'tool-call') { const t = this.tool(b.id, b.name, b.arguments); this.addTool(T, t); }
      else if (b.type === 'image') T.items.push({ kind: 'text', text: 'Image attachment' });
    }
    if (d.interrupted) T.why = 'Interrupted';
    this.paintTurn(T);
    stick();
  },
  endTurn(ev) {
    const T = this.turn;
    const d = ev.data || {};
    const r = d.reason || {};
    const why = r.kind === 'error' ? ((r.error && r.error.message) || 'turn failed')
      : (r.kind === 'aborted' || r.kind === 'interrupted') ? 'Interrupted'
        : r.kind === 'max-tokens' ? 'Output limit reached'
          : r.kind === 'blocked' ? 'Turn blocked' : '';
    if (!T) { if (why) this.note(why, r.kind === 'error' ? 'err' : ''); return; }
    T.done = true;
    T.endedAt = typeof ev.time === 'number' ? ev.time : null;
    T.endEv = ev; // lets a live turn end find the receipt it just closed (announceTurnEnd)
    T.reason = r;
    if (why) T.why = why;
    for (const t of T.tools) if (!t.done) { t.done = true; t.orphan = true; this.paintTool(t); }
    // A turn can end before its last step is finalized (an abort or a killed
    // stream). Keep what had already streamed instead of dropping it with the
    // live element.
    if (T.liveNarration) T.items.push({ kind: 'text', text: T.liveNarration });
    if (T.liveText) T.items.push({ kind: 'text', text: T.liveText });
    if (T.liveThink) T.items.push({ kind: 'reasoning', text: T.liveThink });
    T.liveText = ''; T.liveThink = ''; T.liveNarration = '';
    this.paintTurn(T);
    this.turn = null;
    // A turn with no tools has no receipt to carry the reason, so keep a note.
    if (!T.tools.length && why) this.note(why, r.kind === 'error' ? 'err' : '');
    stick();
  },

  tool(id, name, args) {
    let t = this.tools.get(id);
    if (!t) {
      t = { id, name, args, el: h('details', { class: 'tool run' }) };
      this.tools.set(id, t);
    }
    if (name && !t.name) t.name = name;
    if (args != null && t.args == null) t.args = args;
    this.paintTool(t);
    return t;
  },
  paintTool(t) {
    const terminal = t.rview && t.rview.card === 'terminal';
    const failed = !!t.isError
      || !!(terminal && ((typeof t.rview.exitCode === 'number' && t.rview.exitCode !== 0)
        || (typeof t.rview.signal === 'string' && !!t.rview.signal)));
    const cls = t.done ? (failed ? 'err' : t.orphan && !t.result ? '' : 'ok') : (t.orphan ? '' : 'run');
    t.el.className = 'tool ' + cls;
    const open = t.el.open;
    // dsh 0.1 attaches the presentation view to each event; dsh 0.2 rebuilds it in dsh02.js.
    // A todo_write row has no result view, so its list comes from the call view or arguments.
    const todos = t.name === 'todo_write' && window.dsh02 && window.dsh02.todosFrom
      ? window.dsh02.todosFrom(t.name, t.args, t.view) : null;
    const card = todos ? { card: 'todos', todos } : (t.done && t.rview ? t.rview : t.view) || null;
    const kind = card && card.card;
    const structured = kind === 'read' || kind === 'search' || kind === 'web' || kind === 'todos';
    let sum = toolSummary(t.args, t.view, t.name);
    if (kind === 'todos') sum = '';
    let stat = cardStat(card);
    if (t.done && kind === 'terminal') {
      const res = t.rview || t.view;
      stat = res && typeof res.exitCode === 'number' ? 'exit ' + res.exitCode
        : res && res.signal ? res.signal : stat;
    }
    const first = (t.result || '').split('\n').find((l) => l.trim()) || '';
    const lines = (t.result || '').split('\n').length;
    const resLine = t.done && !structured ? (t.orphan && !t.result ? 'no result' : (first.slice(0, 160) + (lines > 1 ? `  (+${lines - 1} lines)` : ''))) : '';
    const detail = h('div', { class: 'detail' });
    const diffs = window.dshReview ? window.dshReview.diffsOf(t) : null;
    let delta = null;
    if (diffs) {
      let adds = 0, dels = 0;
      for (const df of diffs) {
        const st = window.dshReview.diffStats(window.dshReview.diffLines(df.oldText, df.newText));
        adds += st.adds; dels += st.dels;
      }
      delta = deltaEl(adds, dels);
    }
    // A call that never reported a result is not a success: it keeps the neutral ring.
    const noResult = t.done && t.orphan && !t.result;
    const glyph = statusGlyph(t.done ? (failed ? 'failed' : noResult ? 'idle' : 'done') : (t.orphan ? 'idle' : 'run'), 'bullet');
    const summary = h('summary', {}, glyph, h('span', { class: 'name' }, prettyTool(t.name)),
      failed ? h('span', { class: 'tool-failed' }, 'Failed') : null,
      h('span', { class: 'sum' }, sum), stat ? h('span', { class: 'stat' }, stat) : null, delta);
    const res = t.done && resLine ? h('div', { class: 'res' }, resLine) : null;
    t.el.replaceChildren(...[summary, res, detail].filter(Boolean));
    // Build detail lazily when opened (keeps long histories fast)
    const fill = () => {
      if (detail.childElementCount) return;
      if (diffs) {
        for (const df of diffs) detail.append(diffBlock(df));
        if (t.isError && t.result) detail.append(h('div', { class: 'lbl' }, 'error'), h('pre', {}, clip(t.result, 20000)));
        return;
      }
      if (kind === 'read') { fillRead(detail, card); return; }
      if (kind === 'search') { fillSearch(detail, card); return; }
      if (kind === 'web') { fillWeb(detail, card, t); return; }
      if (kind === 'todos') { fillTodos(detail, card); return; }
      if (t.args != null) detail.append(h('div', { class: 'lbl' }, 'input'), h('pre', {}, clip(prettyArgs(t.args), 20000)));
      const out = (t.rview && typeof t.rview.output === 'string' && t.rview.output) || t.result;
      if (out) detail.append(h('div', { class: 'lbl' }, t.isError ? 'error' : 'output'), h('pre', {}, clip(out, 20000)));
      if (t.rview && t.rview.exitCode != null) detail.append(h('div', { class: 'lbl' }, 'exit ' + t.rview.exitCode));
    };
    t.el.ontoggle = () => { if (t.el.open) fill(); };
    if (open) { t.el.open = true; fill(); }
  },
  paintTurn(T) { paintTurn(T); },
};

// ---------- Review: diffs and turn summaries ----------
const plural = (n, word, plurals) => `${n} ${n === 1 ? word : (plurals || word + 's')}`;
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
  const box = h('details', { class: 'diff', open: true });
  box.append(h('summary', { class: 'dhead' }, h('span', { class: 'dpath' }, relPath(d.path)), deltaEl(st.adds, st.dels)));
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
// The answer/activity split is a pure function of the item list, so history replay
// and live streaming cannot disagree. With tools, the last text after the last tool
// call is the answer; if the turn ended on a tool call, the last text before it is.
// A turn without tools is all prose.
function turnView(T) {
  const items = T.items || [];
  let lastTool = -1;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'tool') { lastTool = i; break; }
  let answerItem = null;
  if (lastTool >= 0) {
    for (let i = items.length - 1; i > lastTool; i--) if (items[i].kind === 'text') { answerItem = items[i]; break; }
    // Only a finished turn may promote text from before its last tool call: while it runs,
    // that text is narration and would jump back into the activity on the next step.
    if (!answerItem && T.done) for (let i = lastTool - 1; i >= 0; i--) if (items[i].kind === 'text') { answerItem = items[i]; break; }
  }
  const live = !T.done && T.liveText ? T.liveText : '';
  if (live) answerItem = null;
  let answer = live;
  if (!answer && lastTool < 0) answer = items.filter((i) => i.kind === 'text').map((i) => i.text).join('\n\n');
  else if (!answer && answerItem) answer = answerItem.text;
  const activity = [];
  if (!T.done && T.liveNarration) activity.push({ kind: 'text', text: T.liveNarration });
  for (const item of items) {
    if (item === answerItem) continue;
    if (lastTool < 0 && (item.kind === 'text' || item.kind === 'reasoning')) continue;
    activity.push(item);
  }
  const thinking = lastTool < 0 ? items.filter((i) => i.kind === 'reasoning') : [];
  return { answer: answer || '', answerItem, activity, thinking, lastTool };
}

function thinkRow(text) {
  return h('details', { class: 'think' }, h('summary', {}, 'Thought'), h('div', { class: 'body' }, text));
}

function activityEl(item) {
  if (item.kind === 'tool') return item.tool.el;
  if (item.kind === 'reasoning') return thinkRow(item.text);
  const el = h('div', { class: 'act-text md' });
  el.innerHTML = md(item.text);
  addCodeCopy(el);
  return el;
}

// What a finished turn's receipt says: the verdict, and the counts beside it. The receipt row
// and the screen reader announcement of a live turn end both read it, so they never disagree.
function receiptFacts(T) {
  const lib = window.dshReview;
  const s = lib ? lib.summarizeTurn(T.tools, T.reason) : { files: [], commands: [], adds: 0, dels: 0, failedCommands: 0, outcome: 'passed', why: '' };
  s.toolCount = T.tools.length;
  if (typeof T.startedAt === 'number' && typeof T.endedAt === 'number') s.elapsed = Math.max(0, T.endedAt - T.startedAt);
  s.label = s.outcome === 'passed' ? 'Passed' : s.outcome === 'failed' ? 'Failed' : 'Stopped';
  s.counts = [
    s.files.length ? plural(s.files.length, 'file') : '',
    s.commands.length ? plural(s.commands.length, 'command') : '',
    !s.files.length && !s.commands.length && s.toolCount ? plural(s.toolCount, 'step') : '',
  ].filter(Boolean);
  return s;
}
function turnCard(T, view) {
  const s = receiptFacts(T);
  const label = s.label;
  const elapsed = typeof s.elapsed === 'number' ? fmtElapsed(s.elapsed) : '';
  const meta = s.counts.concat(elapsed ? [elapsed] : []).join(' · ');
  const state = s.outcome === 'passed' ? 'done' : s.outcome === 'stopped' ? 'stopped' : 'failed';
  const card = h('details', { class: 'turncard ' + s.outcome });
  card.open = s.outcome === 'failed';
  card.append(h('summary', { class: 'receipt' },
    statusGlyph(state, 'receipt-mark'),
    h('b', {}, label),
    h('span', { class: 'receipt-meta' }, meta),
    h('span', { class: 'receipt-chevron', 'aria-hidden': 'true' }, '›')));
  const why = T.why || (s.outcome !== 'passed' ? s.why : '');
  if (why) card.append(h('div', { class: 'tc-why' }, why));
  if (s.files.length) card.append(h('div', { class: 'tc-sec' }, h('span', {}, plural(s.files.length, 'file') + ' changed'), deltaEl(s.adds, s.dels)));
  if (s.commands.length) card.append(h('div', { class: 'tc-sec' }, h('span', {}, plural(s.commands.length, 'command') + ' run' + (s.failedCommands ? `, ${s.failedCommands} failed` : ''))));
  const body = h('div', { class: 'receipt-activity' });
  for (const item of view.activity) body.append(activityEl(item));
  if (!view.activity.length) body.append(h('div', { class: 'tc-more' }, 'No tool activity recorded.'));
  card.append(body);
  if (!T.sawStart) card.append(h('div', { class: 'tc-more' }, 'Earlier steps of this turn are not loaded.'));
  for (const t of T.tools) t.card = card;
  return card;
}

function paintTurn(T) {
  if (!T) return;
  const view = turnView(T);
  if (!T.el) {
    if (!T.items.length && !T.tools.length && !T.liveText && !T.liveThink) return;
    T.el = R.add(h('section', { class: 'transcript-turn running' }));
  }
  T.el.className = 'transcript-turn' + (T.done ? '' : ' running');
  const nodes = [];
  if (view.answer) {
    const el = h('div', { class: 'turn-answer md' });
    el.innerHTML = md(view.answer);
    addCodeCopy(el);
    nodes.push(el);
  }
  if (T.done) {
    if (T.tools.length) nodes.push(turnCard(T, view));
    else for (const r of view.thinking) nodes.push(thinkRow(r.text));
  } else {
    const rows = view.activity.slice();
    if (T.liveThink) rows.push({ kind: 'reasoning', text: T.liveThink });
    if (!T.showAll && rows.length > 3) {
      nodes.push(h('button', { type: 'button', class: 'activity-more', onclick: () => { T.showAll = true; paintTurn(T); } },
        `${rows.length - 3} earlier step${rows.length - 3 === 1 ? '' : 's'}`));
    }
    const wrap = h('div', { class: 'live-activity' });
    for (const row of (T.showAll ? rows : rows.slice(-3))) wrap.append(activityEl(row));
    if (wrap.childNodes.length) nodes.push(wrap);
  }
  T.el.replaceChildren(...nodes);
}

// Streaming deltas arrive many times a second; repainting the whole turn (markdown
// included) on each one stutters on a phone. Coalesce them into one paint per frame.
// paintTurn is a pure function of T, so a paint that lands after a final repaint is
// harmless.
function paintTurnSoon(T) {
  if (T.raf) return;
  const later = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16);
  T.raf = later(() => { T.raf = 0; paintTurn(T); stick(); });
}

// Open a tool row from a receipt and bring it into view. The receipt itself has to
// open first: a row hidden inside a closed <details> cannot be read.
function revealTool(id) {
  const t = R.tools.get(id);
  if (!t) return;
  if (t.card) t.card.open = true;
  t.el.open = true;
  R.paintTool(t);
  t.el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

// ----- Disclosures -----
// A receipt, a tool row, a thought or a diff opens and closes over 220ms instead of jumping.
// It stays a real <details>: the summary still toggles it from the keyboard (Enter and Space
// arrive here as a click), `open` still says the state and `toggle` still fires. Only the height
// between the two states animates, and only where the Web Animations API exists and Reduce
// Motion is off; anywhere else this does nothing and the browser toggles it at once, which is
// the right fallback. A second tap mid-fold turns it round from where it is.
function heightOf(el) {
  const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  return r ? r.height : el.offsetHeight || 0;
}
function foldDetails(d, e) {
  const sum = d.firstElementChild;
  if (!sum || sum.tagName !== 'SUMMARY' || !canAnimate(d) || reducedMotion()) return;
  e.preventDefault();
  const from = heightOf(d);
  const was = d._fold;
  if (was) { d._fold = null; try { was.anim.cancel(); } catch {} }
  const opening = was ? !was.opening : !d.open;
  let to;
  if (opening) {
    delete d.dataset.closing;
    d.open = true;
    // A tool row builds its detail lazily on `toggle`, which fires later: build it now, so the
    // height measured below is the height it opens to.
    if (typeof d.ontoggle === 'function') d.ontoggle();
    to = heightOf(d);
  } else {
    d.dataset.closing = ''; // the chevron turns back as the fold starts (style.css)
    to = heightOf(sum) + (d.offsetHeight - d.clientHeight); // the summary plus the borders
  }
  const done = () => {
    if (d._fold !== fold) return;
    d._fold = null;
    d.style.overflow = '';
    if (!opening) { d.open = false; delete d.dataset.closing; }
  };
  const fold = { opening, anim: null };
  if (Math.abs(to - from) < 1) { d._fold = fold; done(); return; }
  d.style.overflow = 'hidden';
  fold.anim = d.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: MOTION.base, easing: MOTION.standard });
  d._fold = fold;
  fold.anim.onfinish = done;
}
$('#msgs').addEventListener('click', (e) => {
  if (e.defaultPrevented || !e.target || typeof e.target.closest !== 'function') return;
  const sum = e.target.closest('summary');
  if (!sum || e.target.closest('a, button, input, textarea, select')) return;
  const d = sum.parentElement;
  if (d && d.tagName === 'DETAILS' && d.firstElementChild === sum) foldDetails(d, e);
});
// The live row's jobs and subagents: the row is redrawn on every toggle, so its detail opens
// from no height to its own, and closes to none before the redraw drops it.
// One height animation per element: a close that starts mid-open (or the reverse) takes over
// from where the element is, and the earlier animation's onfinish never runs.
function foldStop(el) {
  const running = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
  let from = null;
  for (const a of running) {
    if (from == null && typeof getComputedStyle === 'function') from = parseFloat(getComputedStyle(el).height) || null;
    a.onfinish = null;
    a.cancel();
  }
  return from;
}
function foldOpen(el) {
  if (!canAnimate(el) || reducedMotion()) return;
  const from = foldStop(el);
  const h = heightOf(el);
  if (!h) return;
  el.style.overflow = 'hidden';
  el.animate([{ height: (from || 0) + 'px' }, { height: h + 'px' }], { duration: MOTION.base, easing: MOTION.standard }).onfinish = () => { el.style.overflow = ''; };
}
function foldShut(el, then) {
  if (!el || !canAnimate(el) || reducedMotion()) { then(); return; }
  const from = foldStop(el);
  el.style.overflow = 'hidden';
  el.animate([{ height: (from != null ? from : heightOf(el)) + 'px' }, { height: '0px' }], { duration: MOTION.base, easing: MOTION.standard, fill: 'forwards' }).onfinish = then;
}

// Markdown stays produced by md(), which sanitises before it reaches the DOM. The
// action is added after rendering, so a code block needs no special parser.
function addCodeCopy(root, source) {
  const pres = root && root.querySelectorAll ? Array.from(root.querySelectorAll('pre')) : [];
  for (const pre of pres) {
    if (pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains('codeblock')) continue;
    const wrap = h('div', { class: 'codeblock' });
    const button = h('button', { type: 'button', class: 'code-copy', 'aria-label': 'Copy code' }, 'Copy');
    const code = pre.textContent || source || '';
    button.onclick = () => copyText(code, button);
    if (pre.parentNode) {
      pre.parentNode.insertBefore(wrap, pre);
      wrap.append(pre);
      wrap.append(button);
    }
  }
}


// ---------- Scrolling ----------
let pinned = true;
const feed = $('#feed');
function updateJump() {
  // Jump-to-live only exists while a turn is running; a finished conversation has
  // nothing new to jump to, and a permanent floating pill would sit over the text.
  const running = !!(S.cur && S.running.get(S.cur.id));
  $('#jumpBtn').hidden = pinned || !running;
}
// The handler itself reads no layout: it books one measurement for the next frame, however many
// scroll events arrive before it. stick() checks `pinned` again when its own frame comes, so a
// paint queued just before the user scrolled up cannot pull them back down.
let feedMeasure = 0;
feed.addEventListener('scroll', () => {
  if (feedMeasure) return;
  feedMeasure = requestAnimationFrame(() => {
    feedMeasure = 0;
    pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    updateJump();
  });
}, { passive: true });
// Following the bottom is always an instant jump, never a smooth scroll, so it is the same
// with Reduce Motion on.
function stick(force) {
  if (!(pinned || force)) return;
  requestAnimationFrame(() => { if (pinned || force) feed.scrollTop = feed.scrollHeight; });
}
$('#jumpBtn').onclick = () => { pinned = true; updateJump(); stick(true); };
// The jump-to-bottom button floats over the feed, so keep it above the dock:
// with a pending card open the dock is tall and the button would sit on the
// card's buttons. The dock is the bottom flex row, so its height is the offset.
function positionJump() {
  const jump = $('#jumpBtn'), dock = $('#dock');
  if (!jump || !dock) return;
  const h = dock.offsetHeight;
  if (Number.isFinite(h) && h > 0) jump.style.bottom = (h + 12) + 'px';
}
if (typeof ResizeObserver !== 'undefined') {
  const dock = $('#dock');
  if (dock) new ResizeObserver(() => positionJump()).observe(dock);
}

// ---------- Session view ----------
function sessionMeta(id) { return S.sessions.find((s) => s.sessionId === id) || {}; }

// ---------- View push and pop ----------
// Sessions to a Session slides the session in from the right over 300ms while the board moves
// to -24% and dims; Back reverses it over 260ms. When the direction is not known (the browser's
// own back or forward, which may already have drawn its own swipe) the two crossfade over
// 150ms, and under Reduce Motion every change is a 120ms fade. Only transform and opacity
// animate. The [hidden] state flips at once, so the route, the tests and anything reading
// `hidden` see the new view immediately; the leaving view is only drawn until the move ends.
// A second navigation during a move settles the first at once before it starts.
let viewMove = null; // { finish } while a push, pop or fade is running
function showView(show, hide, mode) {
  if (viewMove) viewMove.finish();
  const wasShown = !show.hidden;
  hide.hidden = true; show.hidden = false;
  const app = $('#app');
  if (!mode || wasShown || !canAnimate(show) || !canAnimate(hide) || !app || !app.classList) return;
  const reduce = reducedMotion();
  if (reduce) mode = 'fade';
  const anims = [];
  const run = (el, frames, ms, easing) => anims.push(el.animate(frames, { duration: ms, easing, fill: 'both' }));
  hide.inert = true;
  hide.classList.add('vt-leaving');
  // The view that moves over the other is on top: the incoming one on a push or a fade, the
  // outgoing one on a pop.
  (mode === 'pop' ? hide : show).classList.add('vt-top');
  app.classList.add('vt');
  if (mode === 'push') {
    run(show, [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], MOTION.push, MOTION.emphasized);
    run(hide, [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-24%)', opacity: 0.7 }], MOTION.push, MOTION.emphasized);
  } else if (mode === 'pop') {
    run(hide, [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], MOTION.pop, MOTION.emphasized);
    run(show, [{ transform: 'translateX(-24%)', opacity: 0.7 }, { transform: 'translateX(0)', opacity: 1 }], MOTION.pop, MOTION.emphasized);
  } else {
    const ms = reduce ? MOTION.fast : MOTION.cross;
    run(show, [{ opacity: 0 }, { opacity: 1 }], ms, reduce ? 'linear' : MOTION.standard);
    run(hide, [{ opacity: 1 }, { opacity: 0 }], ms, reduce ? 'linear' : MOTION.standard);
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    viewMove = null;
    for (const a of anims) { try { a.cancel(); } catch {} }
    app.classList.remove('vt');
    hide.classList.remove('vt-leaving', 'vt-top');
    show.classList.remove('vt-leaving', 'vt-top');
    hide.inert = sheetOpen(); // a sheet open over the views keeps both inert
  };
  viewMove = { finish };
  anims[0].onfinish = finish;
}

async function openSession(id, { push = true, anim } = {}) {
  if (push && location.hash !== '#s/' + id) history.pushState(null, '', '#s/' + id);
  if (dictation.listening) dictateStop(); // the mic button is only in the chat view
  if (S.cur && S.cur.id !== id) markSeen(S.cur.id);
  markSeen(id);
  S.cur = { id, events: [], lastSeq: -1, loading: false, buffer: [], hasMore: false, gen: 0 };
  S.images = []; renderAttachments(); S.steer = false; queueEditing = null; queueOpen = false;
  showView($('#chatView'), $('#listView'), anim !== undefined ? anim : push ? 'push' : 'fade');
  stopDashTick(); // the dashboard is off screen while a chat is open
  const m = sessionMeta(id);
  setNavTitle(S.titles.get(id) || basename(m.cwd) || 'Session', [tildify(m.cwd), m.agentPreset].filter(Boolean).join(' · '));
  R.reset(); pinned = true;
  renderRunning(); renderPending(); renderQueue();
  // Start collapsed and empty: the previous session's line must not linger over
  // this one while its history is still loading.
  renderStatusLine(); renderGoalBar();
  await loadHistory();
  S.commands = [];
  remote('commands/list', { agentId: id }).then((c) => { if (S.cur && S.cur.id === id) S.commands = Array.isArray(c) ? c : []; }).catch(() => {});
  loadModel(id);
  refreshGoal(id);
}
function showList({ push = true, anim } = {}) {
  if (push && location.hash) history.pushState(null, '', location.pathname);
  if (dictation.listening) dictateStop();
  if (S.cur) markSeen(S.cur.id); // everything it did while open has been seen
  S.cur = null;
  showView($('#listView'), $('#chatView'), anim !== undefined ? anim : push ? 'pop' : 'fade');
  loadSessions();
}
// The browser's back and forward (popstate) cannot say which way they went, so they crossfade;
// the first route at boot draws the screen straight away.
window.addEventListener('popstate', () => route('fade'));
function route(anim = null) {
  const m = /^#s[=/](.+)$/.exec(location.hash);
  if (m) openSession(decodeURIComponent(m[1]), { push: false, anim });
  else showList({ push: false, anim });
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
    if (typeof v.cursor === 'number') cur.lastSeq = Math.max(cur.lastSeq, v.cursor);
    if (v.projections && v.projections.values) {
      for (const [key, value] of Object.entries(v.projections.values)) setProjection(cur.id, key, value, -1);
    }
    rerender(true);
    for (const f of v.live || []) R.apply(f); // dsh 0.2: the reply that was mid-stream at the snapshot
    renderRunning(); // the turn's start time is only known once history is in
    if (S.approvals.size) renderPending(); // an approval's call may only now be drawn
    renderStatusLine(); renderGoalBar();
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
  // dsh 0.2's live assistant chunks carry no seq: they only paint the turn in progress.
  if (frame.transient) { R.apply(frame); return; }
  if (seq <= cur.lastSeq) return;
  if (cur.lastSeq >= 0 && seq > cur.lastSeq + 1) { loadHistory(); return; }
  cur.lastSeq = seq;
  cur.events.push(frame);
  const t = frame.event.type;
  if (t === 'turn/start') { S.running.set(cur.id, true); if (typeof frame.event.time === 'number') S.turnStart.set(cur.id, frame.event.time); }
  if (t === 'turn/end') { S.turnStart.delete(cur.id); S.running.set(cur.id, false); }
  R.apply(frame);
  // A frame only reaches here when it is accepted and painted (not buffered during history load,
  // not a duplicate, not a gap that triggers a reload). The receipt is already drawn, so its
  // counts and verdict are available. A duplicate's seq is rejected above and says nothing.
  if (t === 'turn/end') announceTurnEnd(cur.id, frame.event);
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
// A decision (an approval, or a question whose wait has not run out) is waiting in this session.
// While one is, it holds the only primary on screen: the composer stays usable but quiet, and
// whatever is typed queues behind the decision rather than steering past it.
function decisionWaiting() {
  if (!S.cur) return false;
  for (const a of S.approvals.values()) if (belongsToCur(a.sessionId)) return true;
  for (const q of S.questions.values()) if (!q.expired && belongsToCur(q.sessionId)) return true;
  return false;
}
// The composer's one trailing control. It sends; while a turn runs and the field is empty it is
// a stop square in the same place, so there is never a second button beside it. Queue is the
// default while running; Steer is a choice that appears only when there is something to send.
function composerState() {
  const cur = S.cur;
  const running = !!(cur && S.running.get(cur.id));
  const hasText = !!$('#input').value.trim() || S.images.length > 0;
  const waiting = decisionWaiting();
  const stop = running && !hasText;
  const steer = running && hasText && !waiting && S.steer;
  return { running, hasText, waiting, stop, steer };
}
const STEER_OPTIONS = [{ value: 'queue', label: 'Queue' }, { value: 'steer', label: 'Steer' }];
let modeSeg = null;
function paintComposer() {
  const st = composerState();
  const btn = $('#sendBtn');
  btn.setAttribute('data-state', st.stop ? 'stop' : 'send');
  btn.setAttribute('aria-label', st.stop ? 'Stop' : !st.running ? 'Send' : st.steer ? 'Steer the running turn' : 'Queue message');
  btn.title = st.stop ? 'Stop this turn' : st.steer ? 'Send into the running turn' : st.running ? 'Send after this turn' : 'Send';
  btn.disabled = !st.stop && !st.hasText;
  // Quiet while a decision waits: Allow, Approve or Send answer is the one filled accent.
  // That includes Stop, which stays available but stops competing with the decision.
  btn.className = 'cbtn send' + (st.waiting ? ' quiet' : '');
  // Queue / Steer: only while a turn runs, there is something to send, and no decision waits.
  const row = $('#modeRow');
  const show = st.running && st.hasText && !st.waiting;
  row.hidden = !show;
  if (!show) return;
  const want = S.steer ? 'steer' : 'queue';
  if (!modeSeg || modeSeg.segValue() !== want) {
    modeSeg = segmented(STEER_OPTIONS, want, (v) => { S.steer = v === 'steer'; paintComposer(); }, 'When to send');
  }
  const hint = S.steer ? 'Joins the running turn' : 'Sends when this turn ends';
  const label = row.querySelector && row.querySelector('.mode-hint');
  if (label && row.contains && row.contains(modeSeg)) label.textContent = hint;
  else row.replaceChildren(h('span', { class: 'mode-hint' }, hint), modeSeg);
}
function stopTurn() {
  if (!S.cur) return;
  rpc('session.cancel', { sessionId: S.cur.id }).then(() => toast('Stopping…'), (e) => toast('Stop failed: ' + e.message));
}
function renderRunning() {
  const cur = S.cur; if (!cur) return;
  const running = !!S.running.get(cur.id);
  $('#working').hidden = !running;
  updateJump();
  paintComposer();
  clearInterval(workTimer);
  if (running) {
    const t0 = turnStartTime(cur) || Date.now();
    const tick = () => { $('#workingText').textContent = fmtClock(Date.now() - t0); }; // clamp: phone and laptop clocks can differ slightly
    tick(); workTimer = setInterval(tick, 1000);
    if (workTimer && workTimer.unref) workTimer.unref();
    stick();
  }
}
// Queued messages, each with edit and remove. dsh's session.updateQueue acts on one
// item by id; an edit replaces the message's content blocks, so images are kept and
// only the text is swapped. The list is never changed locally: the next
// session/queue event re-renders it.
let queueEditing = null; // {sessionId, id} of the item being edited, so a queue event mid-edit keeps the editor
let queueDraft = '';      // its unsaved text, which survives those re-renders
let queueOpen = false;    // the banner's Review is open: the queue editor shows under it
// One 13px line while messages wait: "2 queued · Review". Review opens the queue editor in place
// (the only nested scroll in the dock); edit and remove work there as before.
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
  if (!items.length) { queueOpen = false; el.replaceChildren(); return; }
  const open = queueOpen || !!queueEditing;
  const toggle = h('button', { type: 'button', class: 'qreview', 'aria-expanded': String(open), 'aria-controls': open ? 'queueList' : null }, open ? 'Done' : 'Review');
  toggle.onclick = () => { queueOpen = !open; if (!queueOpen) queueEditing = null; renderQueue(); };
  const head = h('div', { class: 'qbanner' },
    h('span', { class: 'qcount' }, `${items.length} queued`), h('span', { class: 'qsep', 'aria-hidden': 'true' }, '·'), toggle);
  if (!open) { el.replaceChildren(head); return; }
  // Keep the open editor's node rather than rebuilding it: re-focusing a new textarea
  // outside a tap would drop the iOS keyboard and the caret.
  const keep = queueEditing && el.querySelector(`.qitem.editing[data-id="${CSS.escape(queueEditing.id)}"]`);
  el.replaceChildren(head, h('div', { class: 'qlist', id: 'queueList' },
    ...items.map((it) => (queueEditing && it.id === queueEditing.id ? (keep || queueEditor(cur.id, it)) : queueRow(cur.id, it)))));
}
function queueText(it) { return textOf((it.message && it.message.content) || []); }
const PENCIL = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16z"/></svg>';
const CROSS = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
// An inline line icon from one of the fixed strings above (never page data).
function iconNode(svg) {
  const s = h('span', { class: 'ico-wrap', 'aria-hidden': 'true' });
  s.innerHTML = svg;
  return s;
}
function queueRow(sessionId, it) {
  const imgs = ((it.message && it.message.content) || []).filter((b) => b.type === 'image').length;
  const row = h('div', { class: 'qitem' },
    h('div', { class: 'qtext' }, queueText(it) || (imgs ? '' : '(empty)'), imgs ? h('span', { class: 'qimgs' }, plural(imgs, 'image')) : null));
  const edit = h('button', { type: 'button', class: 'qact', 'aria-label': 'Edit queued message' }, iconNode(PENCIL));
  const rm = h('button', { type: 'button', class: 'qact', 'aria-label': 'Remove queued message' }, iconNode(CROSS));
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
// The send/stop control decides at tap time from the state it shows.
$('#sendBtn').onclick = () => { if (composerState().stop) stopTurn(); else send(); };

// ---------- Session details ----------
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
// so both must be present or there is no fill to show. 80% is the point where the
// number starts changing what to do next; 95% is when it is nearly out of room.
function contextFill(cp) {
  if (!cp) return null;
  const used = typeof cp.projectedTokens === 'number' ? cp.projectedTokens : cp.pressureTokens;
  const capacity = cp.contextWindow;
  if (typeof used !== 'number' || typeof capacity !== 'number' || capacity <= 0) return null;
  const pct = Math.min(100, Math.round((used / capacity) * 100));
  return { pct, level: pct >= 95 ? ' err' : (pct >= 80 ? ' warn' : '') };
}
// The long model prefix that priced this route, for the details sheet. Prices
// match by longest prefix; the shipped table and the device overrides are both
// small, so this stays a display-only scan and does not change pricing itself.
function pricePrefixFor(cur) {
  const lib = window.dshPrices;
  if (!lib || !lib.DEFAULT_PRICES) return null;
  const route = routeFor(cur);
  const id = route && route.model;
  if (!id) return null;
  const table = { ...lib.DEFAULT_PRICES, ...priceOverrides() };
  let best = null;
  for (const prefix of Object.keys(table)) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best;
}
// The one telemetry figure that stays on the glass: the context percentage that
// changes what to do next. Below 80% it is quiet folder + number; at 80% it reads
// "Context N%" in a tinted chip, with the status colour in the tint rather than in
// the text (the default theme's amber is below AA on the canvas).
function renderStatusLine() {
  const cur = S.cur;
  if (!cur) return;
  const fill = contextFill(projectionValue(cur.id, 'contextPressure'));
  const folder = basename(sessionMeta(cur.id).cwd);
  const high = !!fill && fill.pct >= 80;
  const subtitle = high ? `Context ${fill.pct}%` : [folder, fill && `${fill.pct}%`].filter(Boolean).join(' · ');
  const el = $('#subtitle');
  el.textContent = subtitle;
  el.classList.toggle('warn', high && fill.pct < 95);
  el.classList.toggle('danger', high && fill.pct >= 95);
  // Details stay a snapshot while open: re-rendering on every projection would
  // lose its scroll and focus. Opening it, or Refresh, reads the current figures.
}
// Session details: everything the old three-line strip above every conversation
// showed, one tap from the title or the first row of the session menu. The box is
// passed in so a test (and the sheet itself) can render without guessing selectors.
function renderSessionDetails(box = null) {
  const content = box || $('#detailsContent');
  const cur = S.cur;
  if (!cur || !content) return;
  const lib = window.dshPrices;
  const route = routeFor(cur);
  const row = priceRowFor(cur);
  const turns = turnUsage(cur.events);
  const meta = sessionMeta(cur.id);
  const cp = projectionValue(cur.id, 'contextPressure');
  const fill = contextFill(cp);
  const usage = projectionValue(cur.id, 'tokenUsage');
  const buckets = usage ? projectedBuckets(usage) : null;
  const billed = buckets ? sumBuckets(buckets) : 0;
  const total = billed > 0 && route && lib ? lib.costOf(buckets, row) : null;
  const group = (title, ...children) => h('section', { class: 'details-group' }, h('h3', {}, title), ...children);
  const fact = (label, value) => h('div', { class: 'details-fact' }, h('span', {}, label), h('b', {}, value == null || value === '' ? 'n/a' : String(value)));

  const routeGroup = group('Route',
    fact('Model', route && route.model),
    fact('Provider', route && route.provider),
    fact('Agent preset', meta.agentPreset),
    fact('Folder path', meta.cwd));

  const contextKids = fill
    ? [
      h('div', { class: 'context-track', 'aria-hidden': 'true' }, h('span', { class: 'context-fill' + fill.level, style: `width:${fill.pct}%` })),
      fact('Context', `${fill.pct}%`),
      fact('Window', cp.contextWindow ? fmtTokens(cp.contextWindow) : null),
    ]
    : [h('div', { class: 'status-note' }, 'Context not reported.')];
  if (fill && fill.pct >= 80) contextKids.push(h('p', { class: 'status-note' }, 'Context is nearly full. Start a new session or compact before the next long turn.'));

  const usageTable = h('div', { class: 'status-table' });
  for (const [label, alignRight] of [['turn', false], ['in', true], ['out', true], ['read', true], ['write', true], ['est.', false]]) {
    usageTable.append(h('span', { class: 'th' + (alignRight ? ' num' : '') }, label));
  }
  for (const { turn, buckets } of turns) {
    const cost = lib ? lib.costOf(buckets, row) : null;
    usageTable.append(
      h('span', { class: 'turn' }, String(turn)),
      h('span', { class: 'num' }, fmtTokens(buckets.uncachedInputTokens) || '0'),
      h('span', { class: 'num' }, fmtTokens(buckets.outputTokens) || '0'),
      h('span', { class: 'num' }, fmtTokens(buckets.cacheReadTokens) || '0'),
      h('span', { class: 'num' }, fmtTokens(buckets.cacheWriteTokens) || '0'),
      h('span', { class: 'cost' }, cost === null ? 'n/a' : fmtUsd(cost)));
  }
  const usageKids = turns.length
    ? [usageTable, h('div', { class: 'status-note' }, 'Rows cover loaded history. read and write are cache read and cache write.')]
    : [h('div', { class: 'status-note' }, 'No per-turn usage reported yet.')];
  if (cur.hasMore && turns.length) usageKids.push(h('div', { class: 'status-note' }, 'Earlier turns are not loaded yet.'));

  const messages = (cur.events || []).filter((f) => f.event && (f.event.type === 'user/message' || f.event.type === 'assistant/message')).length;
  // dsh does not report a session creation time, so there is no honest "started"
  // row to show. The list row's updated time and the loaded message count are
  // real; the loading note above says when the history is partial.
  const facts = [
    fact('Folder', meta.cwd),
    fact('Preset', meta.agentPreset),
    fact('Updated', meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : null),
    fact('Loaded messages', messages || null),
  ];
  const refresh = h('button', {
    class: 'menuitem', type: 'button',
    onclick: async () => {
      refresh.disabled = true;
      try { await loadHistory(); renderSessionDetails(content); }
      catch { toast('Could not refresh. Check the connection and try again.'); }
      finally { refresh.disabled = false; }
    },
  }, 'Refresh');
  const copy = h('button', {
    class: 'menuitem', type: 'button', disabled: !meta.cwd,
    onclick: () => copyText(meta.cwd, copy),
  }, 'Copy folder path');
  content.replaceChildren(
    routeGroup,
    group('Context', ...contextKids),
    group('Usage', ...usageKids),
    group('Estimated cost',
      fact('Total', total == null ? 'n/a' : 'est. ' + fmtUsd(total)),
      h('div', { class: 'status-note' }, 'USD, from the shipped table; override in Settings > Prices.'),
      h('div', { class: 'status-note' }, `Model prefix: ${pricePrefixFor(cur) || 'n/a'}`)),
    group('Session', ...facts),
    group('Actions', refresh, copy));
}
function sessionDetailsSheet() {
  if (!S.cur) return;
  const content = h('div', { id: 'detailsContent', class: 'session-details' });
  openSheet({ size: 'large' }, h('h3', {}, 'Session details'), content);
  renderSessionDetails(content);
}
$('#sessionTitleButton').onclick = sessionDetailsSheet;
$('#sessionTitleButton').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sessionDetailsSheet(); } };


// ---------- Goals (dsh 0.2) ----------
// The `goal` projection carries the goal and its admitted rounds and arrives like any other
// projection; `goals/get` adds what the projection leaves out, whether continuation is armed.
// Mutations are compare-and-set on the goal's {id, revision}. The older API has no goals, so the
// line never shows and the menu entry is not offered there.
// Literal method names, so scripts/smoke.mjs sees every dsh call the page makes (it lists goals/*
// as newer-API-only rather than probing them against an older dsh).
const GOAL_CALLS = {
  get: (a) => remote('goals/get', a), create: (a) => remote('goals/create', a), edit: (a) => remote('goals/edit', a),
  pause: (a) => remote('goals/pause', a), resume: (a) => remote('goals/resume', a),
  complete: (a) => remote('goals/complete', a), clear: (a) => remote('goals/clear', a),
};
const goalRemote = (verb, args) => GOAL_CALLS[verb](args);
function goalFor(id) {
  if (!dsh2) return null;
  const g = window.dsh02.goalOf(projectionValue(id, 'goal'));
  const v = g && S.goalViews.get(id);
  if (v && v.ref.id === g.ref.id && v.ref.revision === g.ref.revision) g.activation = v.activation;
  return g;
}
function renderGoalBar() {
  const bar = $('#goalBar');
  const g = S.cur && goalFor(S.cur.id);
  bar.hidden = !g;
  if (!g) { bar.replaceChildren(); return; }
  const st = window.dsh02.goalStatus(g);
  bar.replaceChildren(h('span', { class: 'goal-glyph ' + st.level, 'aria-hidden': 'true' }, st.glyph),
    h('span', { class: 'goal-text' }, g.objective), h('span', { class: 'goal-stat' }, st.text));
  // Its name says what it is and what it holds; a bare "Session goal" would hide the goal itself.
  bar.setAttribute('aria-label', ['Goal: ' + (g.objective || ''), st.text].filter(Boolean).join(', '));
}
async function refreshGoal(id) {
  if (!dsh2) return;
  try {
    const g = window.dsh02.goalOf(await goalRemote('get', { agentId: id }));
    if (g) S.goalViews.set(id, g); else S.goalViews.delete(id);
  } catch {} // keep the last known view: a failed lookup (socket down, timeout) is not "no goal"
  if (S.cur && S.cur.id === id) renderGoalBar();
}
$('#goalBar').onclick = () => goalSheet();

// One call, then the sheet shows what dsh answered (or the goal as it now stands, if it refused).
async function goalCall(verb, args, done) {
  const cur = S.cur;
  if (!cur) return null;
  let r = null, stale = false;
  try {
    // Success is the call not throwing: dsh may answer an empty value, which must still count.
    r = (await goalRemote(verb, { agentId: cur.id, ...args })) ?? true;
    if (done) toast(done);
  } catch (e) {
    // dsh answers a stale ref as a generic error whose message says so.
    stale = /stale goal/i.test(e.message || '');
    toast(stale ? 'The goal changed. Showing the latest.' : 'Goal: ' + e.message, 4000);
  }
  await refreshGoal(cur.id).catch(() => {});
  // Redraw the sheet after a success or a stale ref; after any other failure keep what was typed.
  if ((r || stale) && sheetOpen() && S.cur === cur && $('#sheetBody').querySelector('[data-goal-sheet]')) goalSheet();
  return r;
}
function goalForm({ objective = '', maxRounds = null, label, onSave, editing = false }) {
  const box = h('textarea', { rows: 4, placeholder: 'What should this session keep working toward?', 'aria-label': 'Goal objective' });
  box.value = objective;
  const cap = h('input', { type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder: 'default', 'aria-label': 'Round cap', value: maxRounds == null ? '' : String(maxRounds) });
  const go = h('button', { type: 'button', class: 'go' }, label);
  go.onclick = async () => {
    const text = box.value.trim();
    const n = cap.value.trim() === '' ? null : Number(cap.value);
    if (!text) { toast('Write the goal first'); return; }
    if (n !== null && (!Number.isSafeInteger(n) || n < 1)) { toast('The round cap must be a whole number above zero'); return; }
    go.disabled = true;
    await onSave({ objective: text, maxRounds: n });
    go.disabled = false;
  };
  // dsh can change a goal's cap but not remove it, so on an edit a blank cap keeps the current one.
  return [box, h('label', { class: 'goal-rounds' }, 'Round cap', cap, h('span', {}, editing ? 'blank keeps the current cap' : 'blank for dsh’s default')), go];
}
function goalSheet(creating = false) {
  const cur = S.cur; if (!cur) return;
  const g = goalFor(cur.id);
  const mark = (...kids) => h('div', { 'data-goal-sheet': '' }, ...kids);
  if (!g || creating) {
    openSheet(mark(h('h3', {}, g ? 'New goal' : 'Set a goal'),
      h('div', { class: 'note' }, 'One objective for the whole session. dsh keeps going on it, round after round, until it is done, blocked or out of rounds.'),
      ...goalForm({
        label: 'Set goal',
        onSave: async ({ objective, maxRounds }) => {
          const request = maxRounds == null ? { objective } : { objective, maxGoalRounds: maxRounds };
          if (await goalCall('create', { request }, 'Goal set')) closeSheet();
        },
      })));
    return;
  }
  const st = window.dsh02.goalStatus(g);
  const act = (label, fn) => h('button', { type: 'button', onclick: fn }, label);
  const call = (verb, done) => () => goalCall(verb, { ref: g.ref }, done);
  const acts = [];
  if (g.phase === 'active' && g.activation !== 'disarmed') acts.push(act('Pause', call('pause', 'Paused')));
  if (g.phase !== 'complete' && (g.phase !== 'active' || g.activation === 'disarmed')) acts.push(act('Resume', call('resume', 'Resumed')));
  if (g.phase !== 'complete') acts.push(act('Mark complete', call('complete', 'Marked complete')));
  if (g.phase === 'complete') acts.push(act('New goal', () => goalSheet(true)));
  const clear = act('Clear', () => {
    if (!clear.classList.contains('armed')) {
      clear.classList.add('armed'); clear.textContent = 'Tap again to clear';
      setTimeout(() => { clear.classList.remove('armed'); clear.textContent = 'Clear'; }, 3000);
      return;
    }
    goalCall('clear', { ref: g.ref }, 'Goal cleared').then((r) => { if (r) closeSheet(); });
  });
  acts.push(clear);
  openSheet(mark(h('h3', {}, 'Goal'),
    h('div', { class: 'goal-facts' }, `${st.glyph} ${st.text}`, g.blocked ? h('div', { class: 'note err' }, 'Blocked: ' + g.blocked) : null),
    ...goalForm({
      objective: g.objective,
      maxRounds: g.maxRounds,
      label: 'Save changes',
      editing: true,
      onSave: async ({ objective, maxRounds }) => {
        const request = {};
        if (objective !== g.objective) request.objective = objective;
        if (maxRounds != null && maxRounds !== g.maxRounds) request.maxGoalRounds = maxRounds;
        if (!Object.keys(request).length) { toast('Nothing changed'); return; }
        await goalCall('edit', { ref: g.ref, request }, 'Goal updated');
      },
    }),
    h('div', { class: 'goal-acts' }, ...acts)));
  // The armed state may have moved since the last push.
  refreshGoal(cur.id).then(() => {
    const n = goalFor(cur.id);
    if (n && n.activation !== g.activation && sheetOpen() && $('#sheetBody').querySelector('[data-goal-sheet]')) goalSheet();
  });
}

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
// A catalog row's `activity` is as old as the read; the child's own live status is newer.
// An external run has no session, so its `activity` is always inactive: a Claude Code
// transcript written lately is what says it is still working (see claudeLive).
const agentLive = (e, parentId) => e.activity === 'running' || S.running.get(e.id) === true || claudeLive(parentId, e);
function hasLiveAgent(id, depth = 0) {
  const tree = S.subagents.get(id);
  if (!tree || depth > 3) return false;
  return tree.entries.some((e) => e && e.kind === 'child' &&
    (agentLive(e, id) || (e.hasChildren && hasLiveAgent(e.id, depth + 1))));
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
function toggleDashCard(id, refocus) {
  const row = () => (typeof CSS !== 'undefined' && CSS.escape ? $('#runningCards').querySelector(`.run-row[data-session="${CSS.escape(id)}"]`) : null);
  const opening = !S.dashOpen.has(id);
  if (opening) S.dashOpen.add(id); else S.dashOpen.delete(id);
  const redraw = () => {
    dashSig = null;
    renderDashboard();
    const r = row();
    // The rows are redrawn, so a footer tapped from the keyboard hands focus to its new self.
    const btn = r && r.querySelector('.run-more');
    if (refocus && btn) btn.focus();
    if (opening && r) { const detail = r.querySelector('.run-detail'); if (detail) foldOpen(detail); }
  };
  const turn = (dashToggles.get(id) || 0) + 1;
  dashToggles.set(id, turn);
  if (opening) { redraw(); return; }
  // Closing folds the detail that is on screen first, with the chevron already turned back. A
  // tap that reopens it meanwhile wins: the late fold end then leaves the rows alone.
  const r = row();
  const more = r && r.querySelector('.run-more');
  if (more) more.setAttribute('aria-expanded', 'false');
  foldShut(r && r.querySelector('.run-detail'), () => { if (dashToggles.get(id) === turn) redraw(); });
}
const dashToggles = new Map(); // sessionId -> how many times its footer was toggled
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
    if (depth === 0 && agentStale.has(id)) refreshAgentTree(id);
    scheduleDashboard();
  }
}
// The refresh above only runs for sessions already on screen, so a parent whose turn
// ended while a background child works would never be read again and never show. The
// events that change a tree (a subagent added, a child starting or settling, the
// parent's catalog growing) re-read its root at once instead. Coalesced to one read per
// macrotask, after the 0.2 adapter has cached the frame; a read already in flight may
// predate the change, so the root is read again when it finishes.
const agentStale = new Set(); // root sessions whose tree must be read again
let agentRefresh = null;
function refreshAgentTree(id) {
  agentStale.add(rootOf(id));
  if (agentRefresh) return;
  agentRefresh = setTimeout(() => {
    agentRefresh = null;
    for (const root of [...agentStale]) {
      if (S.agentsLoading.has(root)) continue;
      agentStale.delete(root);
      loadAgentTree(root, 0, { n: 0 }).catch(() => {});
    }
  }, 0);
  if (agentRefresh && agentRefresh.unref) agentRefresh.unref();
}
function flattenAgents(parentId, depth, out) {
  const tree = S.subagents.get(parentId);
  if (!tree || depth > 3) return out;
  for (const e of tree.entries) {
    out.push({ e, depth, parent: parentId });
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
// ----- background jobs -----
// dsh 0.1 pushes a `session/jobs` frame per session. dsh 0.2 has no host-wide jobs feed, so
// public/dsh02.js opens one `job/list` stream per session the page wants watched and maps its
// rows onto the same frame. `job/follow` is opened only while a row's output is expanded;
// `job/kill` is 0.2-only, so the stop control appears there and never on the older API.
const JOB_OUT_MAX = 4096;       // render tail for one job's output, in UTF-16 units
const JOB_WATCH_MAX = 64;       // job/list streams one page will open (list is activity-ordered)
const jobPanels = new Map();    // jobId -> the rendered <pre> of an expanded row
function watchDashJobs() {
  if (!dsh2 || typeof dsh2.watchJobs !== 'function') return;
  const ids = [];
  const seen = new Set();
  for (const s of S.sessions) {
    if (ids.length >= JOB_WATCH_MAX) break;
    if (seen.has(s.sessionId)) continue;
    seen.add(s.sessionId); ids.push(s.sessionId);
  }
  // Keep watching a session whose jobs are already known even after it falls out of the cap.
  for (const id of S.jobs.keys()) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  dsh2.watchJobs(ids);
}
function dropJobOutput(jobId) {
  S.jobOut.delete(jobId);
  S.jobOpen.delete(jobId);
  jobPanels.delete(jobId);
  if (dsh2 && typeof dsh2.stopObserve === 'function') dsh2.stopObserve(jobId);
}
// A roster frame is the whole set, so any observed job it no longer lists is gone.
function pruneJobOutput() {
  if (!S.jobOut.size && !S.jobOpen.size) return;
  const present = new Set();
  for (const list of S.jobs.values()) for (const j of list) if (j && j.id) present.add(j.id);
  for (const jobId of [...S.jobOut.keys()]) if (!present.has(jobId)) dropJobOutput(jobId);
  for (const jobId of [...S.jobOpen]) if (!present.has(jobId) && !S.jobOut.has(jobId)) S.jobOpen.delete(jobId);
}
// The terminal `job/follow` status carries the same JobView the roster will push, so merge it
// into the row the page already has rather than resurrect a job the roster dropped.
function mergeJob(sessionId, job) {
  if (!job || job.id == null) return;
  const list = S.jobs.get(sessionId);
  if (!list) return;
  const i = list.findIndex((x) => x && x.id === job.id);
  if (i < 0) return;
  const next = list.slice();
  next[i] = { ...list[i], ...job };
  S.jobs.set(sessionId, next);
}
function jobOutBody(out) {
  if (!out) return '';
  return out.text || (out.error ? out.error : '');
}
function updateJobOutputDom(jobId) {
  const el = jobPanels.get(jobId);
  if (el) el.textContent = jobOutBody(S.jobOut.get(jobId));
}
function handleJobOutput(p) {
  const jobId = p.jobId;
  if (!jobId) return;
  const cur = S.jobOut.get(jobId) || { text: '', gap: false, streaming: true, error: null };
  if (p.kind === 'opened') {
    cur.text = ''; cur.gap = false; cur.error = null; cur.streaming = true;
    mergeJob(p.sessionId, p.job);
  } else if (p.kind === 'output') {
    let text = cur.text;
    for (const c of Array.isArray(p.chunks) ? p.chunks : []) {
      if (c && c.gapBefore === true) cur.gap = true;
      if (c && typeof c.text === 'string') text += c.text;
    }
    if (p.lossy === true) cur.gap = true;
    if (text.length > JOB_OUT_MAX) { cur.gap = true; text = text.slice(text.length - JOB_OUT_MAX); }
    cur.text = text;
  } else if (p.kind === 'status') {
    cur.streaming = false;
    mergeJob(p.sessionId, p.job);
  } else if (p.kind === 'error') {
    cur.streaming = false;
    cur.error = (p.error && p.error.message) || 'output unavailable';
  } else if (p.kind === 'end') {
    cur.streaming = false;
  }
  S.jobOut.set(jobId, cur);
  updateJobOutputDom(jobId);
  if (p.kind === 'status' || p.kind === 'error' || p.kind === 'end') { dashSig = null; scheduleDashboard(); }
}
function jobCanView(j) {
  if (!dsh2 || typeof dsh2.observeJob !== 'function') return false;
  return dashLive(j) || !!(j.output && j.output.total > 0) || S.jobOut.has(j.id);
}
function toggleJobOutput(sessionId, j) {
  if (S.jobOpen.has(j.id)) { dropJobOutput(j.id); dashSig = null; renderDashboard(); return; }
  S.jobOpen.add(j.id);
  S.jobOut.set(j.id, { text: '', gap: false, streaming: true, error: null });
  if (dsh2 && typeof dsh2.observeJob === 'function') dsh2.observeJob(sessionId, j.id);
  dashSig = null;
  renderDashboard();
}
// No prompt/confirm on a phone: the first tap arms, the second stops, a third-second pause disarms.
function stopJobButton(sessionId, j) {
  const label = j.label || j.kind || 'job';
  const btn = h('button', { class: 'jstop', type: 'button', 'aria-label': 'Stop ' + label }, 'Stop');
  let armed = false;
  let timer = null;
  const reset = () => { armed = false; clearTimeout(timer); btn.textContent = 'Stop'; btn.setAttribute('aria-label', 'Stop ' + label); btn.classList.remove('armed'); };
  btn.onclick = async () => {
    if (!armed) {
      armed = true; btn.textContent = 'Sure?'; btn.setAttribute('aria-label', 'Tap again to stop ' + label); btn.classList.add('armed');
      timer = setTimeout(reset, 3000);
      return;
    }
    reset();
    btn.disabled = true; btn.textContent = '…';
    try {
      const v = await dsh2.killJob(sessionId, j.id);
      toast(v && v.outcome === 'already-finished' ? 'That job already finished' : 'Stopping ' + label);
    } catch (e) {
      toast('Could not stop it: ' + ((e && e.message) || 'unknown error'));
      btn.disabled = false; btn.textContent = 'Stop';
    }
  };
  return btn;
}
function jobRow(j, sessionId) {
  const live = dashLive(j);
  const view = jobCanView(j);
  const expanded = S.jobOpen.has(j.id);
  const label = view
    ? h('button', { class: 'jlabel jtoggle', type: 'button', title: j.label || '', 'aria-expanded': String(expanded), onclick: () => toggleJobOutput(sessionId, j) }, j.label || '')
    : h('span', { class: 'jlabel', title: j.label || '' }, j.label || '');
  const row = h('div', { class: 'run-job' },
    statusGlyph(jobGlyph(j.status), 'jdot'),
    h('span', { class: 'jkind' }, j.kind || 'job'),
    label);
  if (live) {
    row.append(h('span', { class: 'jstate' }, j.status || 'running'));
    if (typeof j.startedAt === 'number') row.append(h('span', { class: 'jtime', 'data-since': String(j.startedAt) }, fmtElapsed(Date.now() - j.startedAt)));
  } else row.append(h('span', { class: 'jtime' }, [j.status, j.detail].filter(Boolean).join(' · ')));
  if (view) row.append(h('span', { class: 'jcaret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'));
  if (dsh2 && typeof dsh2.killJob === 'function' && j.status === 'running') row.append(stopJobButton(sessionId, j));
  const wrap = h('div', { class: 'run-jobwrap' }, row);
  if (expanded) {
    const pre = h('pre', { class: 'jout', 'data-job': j.id }, jobOutBody(S.jobOut.get(j.id)));
    jobPanels.set(j.id, pre);
    wrap.append(pre);
  } else {
    jobPanels.delete(j.id);
  }
  return wrap;
}
function agentRow({ e, depth, parent }) {
  const row = h('div', { class: 'run-agent' });
  row.style.setProperty('--depth', String(depth));
  if (e.kind === 'diagnostic') {
    row.append(statusGlyph('failed', 'adot'), h('span', { class: 'aname' }, e.id || 'subagent'), h('span', { class: 'afail' }, e.reason || 'unavailable'));
    return row;
  }
  const live = agentLive(e, parent);
  row.append(statusGlyph(live ? 'run' : 'done', 'adot'));
  row.append(h('span', { class: 'aname', title: e.id || '' }, e.label || e.name || e.id || 'subagent'));
  if (e.mode) row.append(h('span', { class: 'amode' }, e.mode));
  row.append(h('span', { class: 'astate' }, live ? 'running' : 'done'));
  const t = agentTiming(e);
  if (t && t.live) row.append(h('span', { class: 'atime', 'data-since': String(t.since) }, fmtElapsed(Date.now() - t.since)));
  else if (t) row.append(h('span', { class: 'atime' }, fmtElapsed(t.settledMs)));
  return row;
}
// ----- live Claude Code transcripts for external subagents -----
// An external subagent (`subagent_claude_opus` and friends) runs the real Claude Code CLI,
// which sends dsh no progress: its catalog row is `external` and its `activity` never leaves
// inactive. When dsh-rc is given the provider's Claude config dir it serves short, read-only
// summaries of that run's transcript (server/claude-transcripts.mjs). The page cannot tell
// which tool ran an external run (the catalog `name` is the sibling name the model chose,
// `agent-1` and so on), so every external run is looked up by its cwd and start time (one
// transcript per run, nearest first, the catalog label as a tiebreak). One with no transcript
// (Codex, Gemini, or no config dir) simply never matches and shows nothing.
//
// A matched transcript is followed by byte offset for as long as its session is in Running
// now, folded or not, because a transcript written in the last few minutes is what keeps the
// run's dot live and its parent on the dashboard after the parent's turn ends. The activity
// panel itself is drawn only under an expanded card.
const CLAUDE_POLL_MS = 3000;        // a round of reads for runs under an expanded card
const CLAUDE_FIND_EVERY_MS = 6000;  // an unmatched run looks again, and a folded card's run is read, this often
const CLAUDE_FIND_FOR_MS = 60_000;  // for how long after it started an unmatched run keeps looking
const CLAUDE_QUIET_MS = 5 * 60_000; // a transcript unwritten this long no longer counts as working
const CLAUDE_PER_SESSION = 8;       // the most recent external runs per session that are followed
const CLAUDE_KEEP = 30;             // events kept per run
const CLAUDE_SHOW = 6;              // events shown per run
let claudeFeed = null;              // null until the server answers; false when it is not configured
// parentId\0entryId -> {runId, offset, events, updatedAt, activeAt, checkedAt, searchedAt}.
// activeAt is when the transcript was last seen written, checkedAt when it was last read.
const claudeRuns = new Map();
const claudePanels = new Map();     // the same key -> its rendered panel
let claudeTimer = null;
let claudeBusy = false;
const claudeKey = (parentId, entryId) => parentId + '\u0000' + entryId;
const isExternal = (e) => !!e && e.kind === 'child' && e.mode === 'external';
// Liveness is judged as of the last read, so a feed paused while a chat is open neither
// expires a working run nor revives a quiet one; the next read settles it.
function claudeStateLive(st) {
  return !!st && !!st.runId && st.activeAt != null && st.checkedAt - st.activeAt < CLAUDE_QUIET_MS;
}
function claudeLive(parentId, e) {
  return isExternal(e) && claudeStateLive(claudeRuns.get(claudeKey(parentId, e.id)));
}
function externalStart(parentId, e) {
  let v = e.createdAt;
  if (v == null) {
    const cat = projectionValue(parentId, 'subagentCatalog');
    const row = Array.isArray(cat) ? cat.find((r) => r && r.id === e.id) : null;
    v = row ? row.createdAt : null;
  }
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
// The external runs worth matching or following while the list is on screen: the most recent
// few of every working session (a recently written transcript counts as working), plus those of
// a session whose external run started a moment ago and has no match yet, so a parent whose
// turn ends at once still gets its first look before its card can go.
function claudeTargets() {
  if (claudeFeed === false || $('#listView').hidden) return [];
  const now = Date.now();
  const out = [];
  for (const s of S.sessions || []) {
    if (!s.cwd) continue;
    const runs = [];
    for (const { e, parent } of flattenAgents(s.sessionId, 0, [])) {
      if (!isExternal(e)) continue;
      const since = externalStart(parent, e);
      if (since != null) runs.push({ key: claudeKey(parent, e.id), parent, label: e.label || '', cwd: s.cwd, since });
    }
    if (!runs.length) continue;
    const recent = runs.sort((a, b) => b.since - a.since).slice(0, CLAUDE_PER_SESSION);
    const fresh = (r) => Math.abs(now - r.since) < CLAUDE_FIND_FOR_MS && !(claudeRuns.get(r.key) || {}).runId;
    if (!sessionIsWorking(s.sessionId) && !recent.some(fresh)) continue;
    const open = S.dashOpen.has(s.sessionId);
    for (const r of recent) out.push({ ...r, open });
  }
  return out;
}
async function claudeGet(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (checkLogin(r)) throw Object.assign(new Error('login required'), { code: 'login' });
  return { status: r.status, body: r.ok ? await r.json() : null };
}
async function findClaudeRun(target, st, claimed) {
  st.searchedAt = Date.now();
  const q = `cwd=${encodeURIComponent(target.cwd)}&since=${encodeURIComponent(String(target.since))}`;
  const { status, body } = await claudeGet('./claude/runs?' + q);
  if (status !== 200 || !body) return;
  if (body.enabled === false) { claudeFeed = false; return; }
  claudeFeed = true;
  const runs = (Array.isArray(body.runs) ? body.runs : []).filter((r) => r && typeof r.id === 'string' && !claimed.has(r.id));
  if (!runs.length) return;
  // The server lists nearest start first; the catalog label inside the prompt beats that.
  const label = target.label.trim().toLowerCase();
  const byLabel = label.length >= 8 ? runs.find((r) => typeof r.prompt === 'string' && r.prompt.toLowerCase().includes(label)) : null;
  st.runId = (byLabel || runs[0]).id;
  st.offset = null;
  claimed.add(st.runId);
}
// Reads what was appended since the last offset. Answers 'gone' when the server no longer
// knows the id (it restarted, or the file went away), so the caller can look again at once.
async function readClaudeRun(key, st) {
  const first = st.offset == null;
  st.checkedAt = Date.now();
  const url = './claude/runs/' + encodeURIComponent(st.runId) + (first ? '' : '?offset=' + st.offset);
  const { status, body } = await claudeGet(url);
  if (status === 404) { st.runId = null; st.offset = null; return 'gone'; }
  if (status !== 200 || !body) return null;
  const incoming = Array.isArray(body.events) ? body.events : [];
  let events = body.reset ? [] : st.events.slice();
  for (const ev of incoming) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.k === 'result') {
      const call = events.find((x) => x.k === 'tool' && x.id && x.id === ev.id);
      if (call) { call.ok = ev.ok !== false; if (ev.text) call.err = String(ev.text); }
      continue;
    }
    if (ev.k === 'tool' || ev.k === 'text') events.push({ k: ev.k, id: ev.id || '', text: String(ev.text || ''), at: ev.at || null });
  }
  if (events.length > CLAUDE_KEEP) events = events.slice(-CLAUDE_KEEP);
  st.events = events;
  const prevOffset = st.offset, prevUpdated = st.updatedAt;
  if (Number.isSafeInteger(body.offset)) st.offset = body.offset;
  const mtime = typeof body.updatedAt === 'number' ? body.updatedAt : null;
  if (mtime != null) st.updatedAt = mtime;
  const now = Date.now();
  // Growth seen here is timed by this clock. A first read can only go by the file's own time,
  // never later than now, so a server clock ahead of this one cannot stretch it.
  if (!first && (st.offset !== prevOffset || (mtime != null && mtime !== prevUpdated))) st.activeAt = now;
  else if (first && mtime != null) st.activeAt = Math.max(st.activeAt || 0, Math.min(mtime, now));
  updateClaudePanel(key);
  return null;
}
// One round: match what is unmatched, then read what is matched (a folded card's runs at the
// slower pace). Never overlaps itself. Redraws only when a run turns live or quiet; the panels
// update in place.
async function claudeTick() {
  if (claudeBusy) return;
  const targets = claudeTargets();
  if (!targets.length) { stopClaudeFeed(); return; }
  claudeBusy = true;
  let flipped = false;
  try {
    const now = Date.now();
    // Forget runs no longer followed once there are many; following one again reads its tail.
    if (claudeRuns.size > 64) {
      const keep = new Set(targets.map((x) => x.key));
      for (const key of [...claudeRuns.keys()]) if (!keep.has(key)) claudeRuns.delete(key);
    }
    const claimed = new Set();
    for (const st of claudeRuns.values()) if (st.runId) claimed.add(st.runId);
    for (const target of targets) {
      if (claudeFeed === false) break;
      let st = claudeRuns.get(target.key);
      if (!st) {
        st = { runId: null, offset: null, events: [], updatedAt: null, activeAt: null, checkedAt: 0, searchedAt: 0 };
        claudeRuns.set(target.key, st);
      }
      const was = claudeStateLive(st);
      if (!st.runId) {
        const due = !st.searchedAt || (now - target.since < CLAUDE_FIND_FOR_MS && now - st.searchedAt >= CLAUDE_FIND_EVERY_MS);
        if (due) await findClaudeRun(target, st, claimed);
      } else if (!target.open && now - st.checkedAt < CLAUDE_FIND_EVERY_MS) {
        continue;
      }
      if (st.runId && await readClaudeRun(target.key, st) === 'gone') {
        await findClaudeRun(target, st, claimed);
        if (st.runId) await readClaudeRun(target.key, st);
      }
      if (claudeStateLive(st) !== was) flipped = true;
    }
  } catch (e) {
    if (e && e.code === 'login') { stopClaudeFeed(); flipped = false; } // a redraw would restart it
  } finally {
    claudeBusy = false;
  }
  if (flipped) {
    if (!$('#listView').hidden && !S.searchMode) renderList();
    renderDashboard();
  }
}
function syncClaudeFeed() {
  if (!claudeTargets().length) { stopClaudeFeed(); return; }
  if (claudeTimer) return;
  claudeTimer = setInterval(() => { claudeTick(); }, CLAUDE_POLL_MS);
  if (claudeTimer && claudeTimer.unref) claudeTimer.unref();
  claudeTick();
}
function stopClaudeFeed() { if (claudeTimer) { clearInterval(claudeTimer); claudeTimer = null; } }
function fillClaudePanel(el, st) {
  const shown = st ? st.events.slice(-CLAUDE_SHOW) : [];
  el.replaceChildren(...shown.map((ev) => {
    const failed = ev.k === 'tool' && ev.ok === false;
    const mark = ev.k === 'text' ? '“' : failed ? '✗' : ev.ok === true ? '✓' : '›';
    return h('div', { class: 'ce ce-' + ev.k + (failed ? ' fail' : ''), title: failed && ev.err ? ev.err : null },
      h('span', { class: 'ce-mark', 'aria-hidden': 'true' }, mark),
      h('span', { class: 'ce-text' }, ev.text));
  }));
  el.hidden = !shown.length;
}
function claudePanel(parentId, entryId) {
  const key = claudeKey(parentId, entryId);
  const el = h('div', { class: 'run-claude', 'aria-label': 'Recent Claude Code activity' });
  el.style.setProperty('--depth', '0');
  fillClaudePanel(el, claudeRuns.get(key));
  claudePanels.set(key, el);
  return el;
}
function updateClaudePanel(key) {
  const el = claudePanels.get(key);
  if (el) fillClaudePanel(el, claudeRuns.get(key));
}
// A live row's clock starts at the current turn, or at the oldest live job when no turn runs.
// A background subagent is the third way a session stays active; its own timing is the anchor.
function liveSince(id) {
  if (S.running.get(id)) {
    const start = sessionStart(id);
    if (typeof start === 'number') return start;
  }
  const jobStarts = liveJobs(id).map((j) => j.startedAt).filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (jobStarts.length) return Math.min(...jobStarts);
  const agentStarts = flattenAgents(id, 0, []).map(({ e, parent }) => {
    if (!e || e.kind !== 'child' || !agentLive(e, parent)) return null;
    const t = agentTiming(e);
    return t && t.live && typeof t.since === 'number' ? t.since : null;
  }).filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (agentStarts.length) return Math.min(...agentStarts);
  const s = S.sessions.find((x) => x.sessionId === id);
  return s && typeof s.updatedAt === 'number' ? s.updatedAt : null;
}
// The one line of current work: the todo in progress, the running job, a live subagent, or the
// bare fact that a turn is under way. `mono` marks a command, which reads in the machine face.
function currentWork(id, todos) {
  const todo = Array.isArray(todos) && todos.find((t) => t && t.status === 'in_progress' && t.content);
  if (todo) return { text: String(todo.content) };
  const job = liveJobs(id).find((j) => j.label);
  if (job) return { text: String(job.label), mono: true };
  const agent = flattenAgents(id, 0, []).find(({ e, parent }) => e && e.kind === 'child' && agentLive(e, parent));
  if (agent) return { text: agent.e.label ? 'Subagent: ' + agent.e.label : 'Starting a subagent' };
  return S.running.get(id) ? { text: 'Working' } : null;
}
// Context earns a place on the row only once it changes a decision: at 80% and up.
function contextChip(id) {
  const cf = contextFill(projectionValue(id, 'contextPressure'));
  if (!cf || cf.pct < 80) return null;
  const level = cf.pct >= 95 ? ' danger' : cf.pct >= 85 ? ' warn' : '';
  return h('span', { class: 'run-ctx' + level }, `Context ${cf.pct}%`);
}
// A live row in Running now: no card, the same list as the rest of the board.
//   1. glyph, title, and the elapsed clock at the trailing edge
//   2. one line of current work (and the context chip at 80% or more)
//   3. the todo bar with "2 of 5", only when the session reports todos
//   4. a footer, "1 job · 2 subagents", that expands them inline
// The top opens the session and the footer expands it: two separate hit areas.
function liveRow(s) {
  const id = s.sessionId;
  const since = liveSince(id);
  const title = S.titles.get(id) || basename(s.cwd) || 'Session';
  const todos = projectionValue(id, 'todos');
  const work = currentWork(id, todos);
  const chip = contextChip(id);
  const lines = [h('span', { class: 'run-line' },
    // Every row here is active, whether the turn, a job or a subagent is what is working.
    statusGlyph('run', 'run-dot'),
    h('span', { class: 'run-name' }, title),
    since != null ? h('span', { class: 'run-elapsed', 'data-since': String(since) }, fmtClock(Date.now() - since)) : null)];
  if (work || chip) {
    lines.push(h('span', { class: 'run-sub' },
      h('span', { class: 'run-current' + (work && work.mono ? ' mono-line' : '') }, work ? work.text : ''),
      chip));
  }
  if (Array.isArray(todos) && todos.length) {
    const done = todos.filter((t) => t && t.status === 'completed').length;
    const fill = h('span', { class: 'run-fill' });
    fill.style.setProperty('--fill', Math.round((done / todos.length) * 100) + '%');
    lines.push(h('span', { class: 'run-meter' },
      h('span', { class: 'run-track', 'aria-hidden': 'true' }, fill),
      h('span', { class: 'run-meter-value' }, `${done} of ${todos.length}`)));
  }
  const top = h('button', { class: 'run-top', type: 'button', onclick: () => openSession(id) }, lines);
  const row = h('li', { class: 'run-row', 'data-session': id }, top);

  const jobs = S.jobs.get(id) || [];
  const agents = flattenAgents(id, 0, []);
  if (!jobs.length && !agents.length) return row; // nothing to expand, so no footer: a shorter row
  const bits = [jobs.length ? plural(jobs.length, 'job') : null, agents.length ? plural(agents.length, 'subagent') : null].filter(Boolean);
  const expanded = S.dashOpen.has(id);
  const more = h('button', { class: 'run-more', type: 'button', 'aria-expanded': String(expanded), onclick: () => toggleDashCard(id, true) },
    h('span', { class: 'run-more-txt' }, bits.join(' · ')),
    h('span', { class: 'run-caret', 'aria-hidden': 'true' }));

  const detail = h('div', { class: 'run-detail' });
  if (jobs.length) {
    detail.append(h('div', { class: 'run-sec-title' }, 'Background jobs'));
    const ordered = jobs.slice().sort((a, b) => (dashLive(b) ? 1 : 0) - (dashLive(a) ? 1 : 0));
    for (const j of ordered.slice(0, 8)) detail.append(jobRow(j, id));
    if (ordered.length > 8) detail.append(h('div', { class: 'run-empty' }, `+${ordered.length - 8} more`));
  }
  if (agents.length) {
    detail.append(h('div', { class: 'run-sec-title' }, 'Subagents'));
    for (const node of agents.slice(0, 24)) {
      detail.append(agentRow(node));
      // Only an expanded row carries the feed panel; a folded one is still followed for liveness.
      if (expanded && isExternal(node.e)) {
        const panel = claudePanel(node.parent, node.e.id);
        panel.style.setProperty('--depth', String(node.depth));
        detail.append(panel);
      }
    }
    if (agents.length > 24) detail.append(h('div', { class: 'run-empty' }, `+${agents.length - 24} more`));
  }
  detail.hidden = !expanded;
  row.append(more, detail);
  return row;
}
// The todo bar moves from where it was to where it is over 240ms. The rows are rebuilt on a
// change, so the old fill is read before the rebuild and the new bar starts as a scale of
// itself from the left edge back to its own width: transform only, nothing reflows. The
// "2 of 5" beside it changes at once.
function todoFills() {
  const out = new Map();
  const box = $('#runningCards');
  if (!box || typeof box.querySelectorAll !== 'function') return out;
  for (const row of box.querySelectorAll('.run-row')) {
    const fill = row.querySelector && row.querySelector('.run-fill');
    const v = fill && fill.style && typeof fill.style.getPropertyValue === 'function' ? parseFloat(fill.style.getPropertyValue('--fill')) : NaN;
    if (Number.isFinite(v)) out.set(row.getAttribute('data-session'), v);
  }
  return out;
}
function growTodoFills(before) {
  if (!before.size || reducedMotion()) return;
  for (const row of $('#runningCards').querySelectorAll('.run-row')) {
    const was = before.get(row.getAttribute('data-session'));
    const fill = row.querySelector('.run-fill');
    if (was == null || !canAnimate(fill)) continue;
    const now = parseFloat(fill.style.getPropertyValue('--fill'));
    if (!(now > 0) || now === was) continue;
    fill.animate([{ transform: `scaleX(${was / now})` }, { transform: 'none' }], { duration: MOTION.progress, easing: MOTION.standard });
  }
}
function agentsSig(parentId, depth) {
  const tree = S.subagents.get(parentId);
  if (!tree || depth > 3) return '';
  const out = [];
  for (const e of tree.entries) {
    // An external run's transcript liveness draws its dot, so its turning live or quiet redraws.
    out.push([e.kind, e.id, e.activity, e.mode, e.label, e.reason, claudeLive(parentId, e) ? 'live' : null].filter((x) => x != null).join(':'));
    const t = agentTiming(e);
    if (t) out.push(t.live ? 's' + t.since : 'd' + t.settledMs);
    if (e.kind === 'child' && e.hasChildren) out.push('(' + agentsSig(e.id, depth + 1) + ')');
  }
  return out.join(',');
}
// What the live rows would render, with time-derived strings left out so the 1s
// ticker never forces a rebuild.
function dashboardSignature(list) {
  const parts = [];
  for (const s of list) {
    const id = s.sessionId;
    parts.push(id, S.running.get(id) ? 'run' : 'idle', 'S' + (sessionStart(id) || ''), 'N' + (S.titles.get(id) || s.cwd || ''));
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
    // The row's own clock reads 4:12; a job or subagent inside it keeps "4m 12s".
    if (Number.isFinite(since)) el.textContent = (el.classList.contains('run-elapsed') ? fmtClock : fmtElapsed)(now - since);
  }
}
// Running now: one live row per active session that is not waiting on the user (a waiting one
// is in Needs you). The other sections leave these sessions out, so a change in who is running
// redraws the whole board first.
function renderDashboard() {
  const box = $('#running');
  if (!box) return;
  if ($('#listView').hidden) { stopDashTick(); stopClaudeFeed(); return; }
  const all = activeSessions();
  const waiting = waitingSessions();
  const active = all.filter((s) => !waiting.has(s.sessionId));
  if (active.map((s) => s.sessionId).join('\u0000') !== boardKey && !S.searchMode) { renderList(); return; }
  // A waiting session can still be working: keep its subagent tree fresh for when it returns.
  if (all.length) ensureAgentTrees(all);
  // With no live row on screen a just-started external run may still be looking for its transcript.
  if (!active.length) { box.hidden = true; dashSig = null; stopDashTick(); syncClaudeFeed(); return; }
  box.hidden = false;
  const sig = dashboardSignature(active);
  if (sig !== dashSig) {
    dashSig = sig;
    claudePanels.clear();
    const fills = todoFills();
    $('#runningCards').replaceChildren(...active.map(liveRow));
    $('#runningCount').textContent = String(active.length);
    growTodoFills(fills);
  }
  startDashTick();
  syncClaudeFeed();
}

// ---------- Approvals & questions ----------
// Decision cards sit above the composer in #pending, which scrolls and is capped, so a long
// command never pushes the composer away. Each card is one focused surface: a kicker with the
// time it has waited, a 17px title, the detail, and one primary with one escape. A card's node is
// kept while its request is unchanged, so another card arriving never drops a chosen option, a
// typed answer or the keyboard.
const pendingNodes = new Map(); // rpcId -> { sig, node, clock, since }: the drawn card and its waiting clock
let pendingTick = null;
let planSheetRpc = null; // the plan whose review sheet is open
let planSheetHead = null; // that sheet's heading node, to tell it from any other sheet
const argKey = (raw) => (raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw));
// The call's arguments: from the frame when dsh sent them, else the drawn call, else what the
// history lookup found (lookupApprovalArgs repaints the card when that lands).
function approvalArgs(a) { return a.args != null ? a.args : a.input != null ? a.input : drawnCallArgs(a); }
const SHELL_TOOLS = /^(bash|shell|sh|terminal|exec|run_command|run_terminal_cmd)$/i;
const EDIT_TOOLS = /^(edit|write|multi_edit|multiedit|apply_patch|notebook_edit)$/i;
function approvalTitle(a, raw) {
  const p = raw == null ? null : parseArgs(raw);
  if (SHELL_TOOLS.test(a.toolName || '') || (p && typeof p.command === 'string')) return 'Run this command?';
  if (EDIT_TOOLS.test(a.toolName || '')) return 'Change this file?';
  return `Allow ${prettyTool(a.toolName)}?`;
}
// The kicker row: 11px tracked caps, and the time the request has waited at the trailing edge.
function decisionHead(kicker, since, tone) {
  const clock = since ? h('span', { class: 'dec-clock' }, fmtClock(Date.now() - since)) : null;
  const wait = clock ? h('span', { class: 'dec-wait' }, h('span', { class: 'vh' }, 'Waiting '), clock) : null;
  return { row: h('div', { class: 'dec-kick' }, h('span', { class: 'kicker' + (tone ? ' ' + tone : '') }, kicker), wait), clock };
}
const subNote = (id) => (id !== (S.cur && S.cur.id) ? ' · subagent' : '');
function tickPending() {
  const now = Date.now();
  for (const p of pendingNodes.values()) if (p.clock && p.since) p.clock.textContent = fmtClock(now - p.since);
}
function paintPendingTick() {
  const any = [...pendingNodes.values()].some((p) => p.clock);
  if (any && !pendingTick) {
    pendingTick = setInterval(tickPending, 1000);
    if (pendingTick && pendingTick.unref) pendingTick.unref();
  } else if (!any && pendingTick) { clearInterval(pendingTick); pendingTick = null; }
}
function renderPending() {
  const box = $('#pending');
  const cards = [];
  const live = new Set();
  const use = (rpcId, sig, build) => {
    const kept = pendingNodes.get(rpcId);
    const made = kept && kept.sig === sig ? kept : { sig, ...build() };
    pendingNodes.set(rpcId, made);
    live.add(rpcId);
    cards.push(made.node);
  };
  if (S.cur) {
    for (const a of S.approvals.values()) {
      if (!belongsToCur(a.sessionId)) continue;
      const raw = approvalArgs(a);
      use(a.rpcId, `a|${argKey(raw)}|${a.lookup || ''}|${a.since || ''}`, () => approvalCard(a, raw));
    }
    for (const q of S.questions.values()) {
      if (!belongsToCur(q.sessionId)) continue;
      const review = window.dshReview && window.dshReview.planReviewOf(q.questions);
      const sig = (review ? 'p' : 'q') + (q.expired ? 'x' : '') + '|' + JSON.stringify(q.questions || []);
      use(q.rpcId, sig, () => (review ? planCard(q, review) : questionCard(q)));
    }
  }
  for (const id of [...pendingNodes.keys()]) if (!live.has(id)) pendingNodes.delete(id);
  // The plan was answered elsewhere: the review sheet has nothing left to decide. An expired
  // plan can still be answered, so its sheet stays.
  if (planSheetRpc && !live.has(planSheetRpc)) {
    const open = sheetOpen() && !!planSheetHead && sheetCur.heading === planSheetHead;
    planSheetRpc = null;
    if (open) closeSheet();
  }
  box.replaceChildren(...cards);
  if (cards.length) stick();
  positionJump();
  paintComposer();
  paintPendingTick();
}
// Answer one request. The card's buttons are disabled while it is in flight; on failure they
// come back with their labels.
async function settleDecision(rpcId, result, btns, btn, done) {
  const label = btn.textContent;
  btns.forEach((b) => { b.disabled = true; });
  btn.textContent = '…';
  try {
    await respond(rpcId, result);
  } catch (e) {
    toast(e.message);
    btns.forEach((b) => { b.disabled = false; });
    btn.textContent = label;
    return false;
  }
  done();
  return true;
}
// The approval: the command in full, then Allow (the one filled control) and Deny (plain).
// The block wraps rather than clipping or scrolling sideways, so no part of the command hides.
function approvalCard(a, raw) {
  const text = raw != null ? prettyArgs(raw) : '';
  const since = a.since || a.seenAt;
  const head = decisionHead(`Approval · ${prettyTool(a.toolName)}${subNote(a.sessionId)}`, since, 'warn');
  let block = null;
  if (text) {
    const copy = h('button', { type: 'button', class: 'cmd-copy', 'aria-label': 'Copy the command' }, 'Copy');
    copy.onclick = () => copyText(text, copy);
    block = h('div', { class: 'cmd-block' }, copy, h('pre', { class: 'cmd-text' }, text)); // Copy first: it floats beside the first line
  } else if (a.lookup === 'pending') {
    block = h('div', { class: 'cmd-block loading' }, h('span', { class: 'cmd-wait' }, 'Reading the command…'));
  }
  const card = h('div', { class: 'card decision approval', 'data-rpc': a.rpcId },
    head.row,
    h('h3', { class: 'dec-title' }, approvalTitle(a, raw)),
    a.reason ? h('p', { class: 'dec-why' }, a.reason) : null,
    block);
  const yes = h('button', { type: 'button', class: 'btn btn-primary dec-btn' }, 'Allow');
  const no = h('button', { type: 'button', class: 'btn btn-plain dec-btn' }, 'Deny');
  const answer = (outcome, btn) => settleDecision(a.rpcId, { ok: true, value: { sessionId: a.sessionId, approvalId: a.approvalId, outcome } }, [yes, no], btn,
    () => { S.approvals.delete(a.approvalId); renderPending(); badge(); });
  yes.onclick = () => answer('allowed-once', yes);
  no.onclick = () => answer('rejected', no);
  card.append(h('div', { class: 'dec-actions' }, yes, no));
  return { node: card, clock: head.clock, since };
}
// A question: each prompt at 17px, options as 44px rows with a check (an empty ring or box until
// chosen, so the choice never rests on colour), an optional free-text field, and Send answer.
function questionCard(q) {
  const qs = q.questions || [];
  const state = qs.map((qq) => ({ id: qq.id, selected: new Set(), custom: '' }));
  const lone = qs.length === 1 && qs[0].header ? ` · ${qs[0].header}` : '';
  const head = decisionHead(`${q.expired ? 'Expired question' : 'Question'}${lone}${subNote(q.sessionId)}`, q.expired ? null : q.seenAt, q.expired ? 'muted' : 'warn');
  const card = h('div', { class: 'card decision question' + (q.expired ? ' expired' : ''), 'data-rpc': q.rpcId }, head.row);
  if (q.expired) card.append(expiredNote());
  qs.forEach((qq, i) => {
    const st = state[i];
    card.append(h('h3', { class: 'dec-title' }, !lone && qq.header ? `${qq.header}: ` : '', qq.question));
    if (qq.detail) card.append(h('p', { class: 'dec-why' }, qq.detail));
    const role = qq.multiSelect ? 'checkbox' : 'radio';
    const opts = h('div', { class: 'opts', role: qq.multiSelect ? 'group' : 'radiogroup', 'aria-label': qq.header || qq.question || 'Options' });
    const buttons = [];
    for (const o of qq.options || []) {
      const b = h('button', { type: 'button', class: 'opt', role, 'aria-checked': 'false', 'data-label': o.label },
        h('span', { class: 'opt-check' + (qq.multiSelect ? ' multi' : ''), 'aria-hidden': 'true' }),
        h('span', { class: 'opt-main' }, h('span', { class: 'opt-label' }, o.label), o.description ? h('small', {}, o.description) : null));
      buttons.push(b);
      opts.append(b);
    }
    // A single choice behaves as a radio group: one tab stop, arrow keys move and choose.
    // Multi-select keeps every checkbox tabbable and leaves the arrow keys alone.
    const choose = (b, focus) => {
      const label = b.getAttribute('data-label');
      if (qq.multiSelect) { st.selected.has(label) ? st.selected.delete(label) : st.selected.add(label); }
      else { st.selected.clear(); st.selected.add(label); }
      for (const x of buttons) {
        const on = st.selected.has(x.getAttribute('data-label'));
        x.setAttribute('aria-checked', String(on));
        x.className = 'opt' + (on ? ' sel' : '');
        if (!qq.multiSelect) x.tabIndex = on ? 0 : -1;
      }
      if (focus) b.focus();
    };
    buttons.forEach((b, bi) => {
      b.onclick = () => choose(b, false);
      if (qq.multiSelect) return;
      b.tabIndex = bi === 0 ? 0 : -1;
      b.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        choose(buttons[(bi + step + buttons.length) % buttons.length], true);
      });
    });
    if (buttons.length) card.append(opts);
    const other = h('input', { type: 'text', class: 'field dec-field', placeholder: buttons.length ? 'Other answer (optional)' : 'Your answer', 'aria-label': buttons.length ? 'Other answer' : 'Your answer', enterkeyhint: 'done' });
    other.oninput = () => { st.custom = other.value; };
    card.append(other);
  });
  const send = h('button', { type: 'button', class: 'btn btn-primary dec-btn' }, 'Send answer');
  const skip = h('button', { type: 'button', class: 'btn btn-plain dec-btn' }, q.expired ? 'Dismiss' : 'Skip');
  const done = () => { S.questions.delete(q.rpcId); renderPending(); badge(); };
  send.onclick = () => {
    const answers = state.map((st) => {
      const a = { id: st.id, selected: [...st.selected] };
      if (st.custom.trim()) a.custom = st.custom.trim();
      return a;
    });
    settleDecision(q.rpcId, { ok: true, value: { sessionId: q.sessionId, answer: { answers } } }, [send, skip], send, done);
  };
  skip.onclick = () => settleDecision(q.rpcId, { ok: false, error: { code: 'cancelled', message: 'Skipped from mobile', details: {} } }, [send, skip], skip, done);
  card.append(h('div', { class: 'dec-actions' }, send, skip));
  return { node: card, clock: head.clock, since: q.seenAt };
}
// A request whose timed wait ran out: the agent carried on without it, but dsh still takes a
// late answer through the same call, so the card keeps its controls and says what happened.
function expiredNote() {
  return h('p', { class: 'dec-why expired-note' }, 'The wait ran out and the agent carried on. You can still answer.');
}

// Plan mode asks for review through an ordinary question tagged plan-review, with the plan as
// markdown in its detail. In the dock it is a compact card: the goal and the first two steps,
// and Review plan, which opens the whole plan in a large sheet to be read at 17px. The card
// stays behind the sheet, so closing the sheet loses nothing. Answers use the labels dsh named.
const planDrafts = new Map(); // rpcId -> feedback typed so far, kept across re-renders and sheet closes
const mdPlain = (s) => String(s || '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#+\s*/, '').trim();
// The plan's goal and its steps, read from the markdown: a "Goal:" line, else the first heading,
// else the first line of prose; the steps are its list items, in order.
function planOutline(plan) {
  const steps = [];
  let goal = '', heading = '', prose = '';
  for (const raw of String(plan || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const g = /^(?:\*\*|__)?goal(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/i.exec(line);
    if (g && !goal) { goal = mdPlain(g[1]); continue; }
    const item = /^(?:\d+[.)]|[-*+])\s+(.+)$/.exec(line);
    if (item) { steps.push(mdPlain(item[1])); continue; }
    if (/^#{1,6}\s/.test(line)) { if (!heading) heading = mdPlain(line); continue; }
    if (!prose) prose = mdPlain(line);
  }
  return { goal: goal || heading || prose || 'Review the plan', steps };
}
function planCard(q, review) {
  const { goal, steps } = planOutline(review.plan);
  const head = decisionHead(`${q.expired ? 'Expired plan review' : 'Plan review'}${subNote(q.sessionId)}`, q.expired ? null : q.seenAt, q.expired ? 'muted' : 'warn');
  const open = h('button', { type: 'button', class: 'btn btn-primary dec-btn', 'aria-haspopup': 'dialog' }, 'Review plan');
  open.onclick = () => planSheet(q, review);
  const card = h('div', { class: 'card decision plan' + (q.expired ? ' expired' : ''), 'data-rpc': q.rpcId },
    head.row,
    q.expired ? expiredNote() : null,
    h('h3', { class: 'dec-title plan-goal' }, goal),
    steps.length ? h('ol', { class: 'plan-steps' }, ...steps.slice(0, 2).map((s) => h('li', {}, s))) : null,
    steps.length > 2 ? h('p', { class: 'dec-why plan-more' }, `and ${plural(steps.length - 2, 'more step')}`) : null,
    h('div', { class: 'dec-actions' }, open));
  return { node: card, clock: head.clock, since: q.seenAt };
}
// The full plan at 17/24, a feedback field, and a sticky footer: Approve (the one filled
// control), Keep planning (quiet fill, sends the feedback) and Reply instead (plain: closes the
// review and leaves dsh in plan mode waiting for a message).
function planSheet(q, review) {
  const lib = window.dshReview;
  planSheetRpc = q.rpcId;
  const body = h('div', { class: 'md plan-doc' });
  body.append(mdNode(review.plan));
  let fb = null;
  if (review.decline) {
    fb = h('textarea', { rows: '1', class: 'field plan-fb', id: 'planFeedback', placeholder: 'Optional' });
    fb.value = planDrafts.get(q.rpcId) || '';
    fb.oninput = () => { planDrafts.set(q.rpcId, fb.value); };
  }
  const approve = h('button', { type: 'button', class: 'go' }, review.approve.label);
  const keep = review.decline ? h('button', { type: 'button', class: 'btn btn-secondary plan-keep' }, review.decline.label) : null;
  const reply = h('button', { type: 'button', class: 'btn btn-plain plan-reply' }, 'Reply instead');
  const btns = [approve, keep, reply].filter(Boolean);
  const finish = (focusInput) => () => {
    S.questions.delete(q.rpcId); planDrafts.delete(q.rpcId);
    planSheetRpc = null;
    closeSheet();
    renderPending(); badge();
    if (focusInput) input.focus();
  };
  approve.onclick = () => settleDecision(q.rpcId, { ok: true, value: { sessionId: q.sessionId, answer: lib.planAnswer(review, true) } }, btns, approve, finish(false));
  if (keep) keep.onclick = () => settleDecision(q.rpcId, { ok: true, value: { sessionId: q.sessionId, answer: lib.planAnswer(review, false, fb ? fb.value : '') } }, btns, keep, finish(false));
  reply.onclick = () => settleDecision(q.rpcId, { ok: false, error: { code: 'cancelled', message: 'the user closed this question request', details: {} } }, btns, reply, finish(true));
  planSheetHead = h('h3', {}, 'Plan review');
  openSheet({ size: 'large' }, planSheetHead,
    review.question ? h('p', { class: 'plan-ask' }, review.question) : null,
    body,
    fb ? h('label', { for: 'planFeedback' }, `Feedback, sent with ${review.decline.label}`) : null,
    fb,
    ...btns);
}

// ---------- Composer ----------
const input = $('#input');
// The field grows with its text; the stylesheet caps it at about five lines, then it scrolls.
// Every value change goes through here, so the send/stop control follows the text.
function grow() {
  input.style.height = 'auto';
  const border = (input.offsetHeight || 0) - (input.clientHeight || 0);
  input.style.height = (input.scrollHeight + Math.max(0, border)) + 'px';
  paintComposer();
}
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
  const bubble = R.add(h('div', { class: 'user pending', 'data-rpc': rpcId }, text, ...images.map((im) => h('img', { class: 'transcript-image', src: im.url, alt: 'Image attachment' }))));
  pinned = true; stick(true);
  input.value = ''; grow(); S.images = []; renderAttachments();
  // Queue unless Steer was chosen for this message while a turn runs; a waiting decision always
  // queues, so a typed message never slips past an approval.
  const mode = S.steer && S.running.get(cur.id) && !decisionWaiting() ? 'steer' : 'queue';
  const payload = { sessionId: cur.id, mode, content };
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

// The plus menu: everything that adds to a message, labelled, one tap from the composer.
// dsh sessions take images, not arbitrary files, so Photo library and File both open the image
// picker (the phone offers its photos, camera and Files from it); File says so.
function pickImages() { closeSheet(); $('#fileInput').click(); }
function plusSheet() {
  // A sheet row that opens another sheet closes this one first, so there is no empty action
  // sheet left to go Back to. The composer gets focus back, which is also where a template or a
  // command belongs; the caret is read now, before the sheet can blur it.
  const sel = [input.selectionStart, input.selectionEnd];
  const then = (fn) => () => {
    closeSheet();
    fn();
    // The row that opened this is gone, so hand focus back to the composer when the next
    // sheet closes. Setting it after openSheet avoids raising the keyboard just to blur it.
    sheetReturn = input;
  };
  const item = (label, hint, onclick) => h('button', { type: 'button', class: 'menuitem', onclick }, label, h('small', {}, hint));
  openSheet({ size: 'medium' }, h('h3', {}, 'Add to message'),
    item('Photo library', 'Attach photos', pickImages),
    item('File', 'Attach an image file (images only)', pickImages),
    item('Prompt template', 'Insert or save a saved prompt', then(() => templatesSheet(sel))),
    item('Commands', 'Slash commands for this session', then(commandsSheet)));
}
$('#attachBtn').onclick = plusSheet;
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
  paintComposer();
  // A 56px thumbnail with a 22px remove glyph whose button is a 44px hit area.
  box.replaceChildren(...S.images.map((im, i) => h('div', { class: 'thumb' }, h('img', { src: im.url, alt: im.name ? 'Attached image ' + im.name : 'Attached image' }),
    h('button', { type: 'button', class: 'thumb-x', 'aria-label': 'Remove image ' + (i + 1), onclick: () => { S.images.splice(i, 1); renderAttachments(); } },
      h('span', { class: 'thumb-x-ink', 'aria-hidden': 'true' }, iconNode(CROSS))))));
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

// ---------- Shell: nav title, scroll edges, segmented control ----------
// The chat bar's centred title and its one-line subtitle; a blank subtitle hides the line.
// Either can be left undefined to keep what is there.
function setNavTitle(title, subtitle) {
  if (title !== undefined) $('#title').textContent = title;
  if (subtitle !== undefined) $('#subtitle').textContent = subtitle || '';
}
// A bar's hairline shows only while content sits under it. A 1px sentinel at each end of the
// scroller says when that is, so no scroll handler has to read layout.
function scrollEdges(scroller, top, bottom) {
  if (typeof IntersectionObserver !== 'function' || !scroller) return;
  const mark = () => h('div', { class: 'edge-sentinel', 'aria-hidden': 'true' });
  const head = mark(), foot = bottom ? mark() : null;
  scroller.prepend(head);
  if (foot) scroller.append(foot);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const bar = e.target === head ? top : bottom;
      if (bar) bar.classList.toggle('edge', !e.isIntersecting);
    }
  }, { root: scroller });
  io.observe(head);
  if (foot) io.observe(foot);
}
scrollEdges($('#listScroll'), $('#listNav'), $('#listDock'));
scrollEdges($('#feed'), $('#chatNav'), null);
// Segmented control: options [{ value, label }], the current value and onChange(value). A
// radiogroup, so a screen reader announces it as one choice and the arrow keys move it.
function segmented(options, value, onChange, label) {
  const group = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label || null });
  let current = value;
  // data-label lets each label reserve its semibold width (style.css), so choosing never reflows.
  const buttons = options.map((o) => h('button', { type: 'button', role: 'radio', 'data-value': o.value, 'data-label': o.label }, o.label));
  // The thumb is the track's ::before: --seg-n sizes it, --seg-i says which label it sits under,
  // and the stylesheet slides it there over 220ms.
  const prop = (k, v) => { if (group.style && typeof group.style.setProperty === 'function') group.style.setProperty(k, v); };
  prop('--seg-n', String(options.length));
  const paint = () => {
    buttons.forEach((b, i) => {
      const on = b.getAttribute('data-value') === String(current);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on) prop('--seg-i', String(i));
    });
  };
  const pick = (v, focus) => {
    if (String(v) === String(current)) return;
    current = v; paint();
    if (focus) { const b = buttons.find((x) => x.getAttribute('data-value') === String(v)); if (b) b.focus(); }
    if (onChange) onChange(v);
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => pick(options[i].value));
    b.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      pick(options[(i + step + options.length) % options.length].value, true);
    });
  });
  group.append(...buttons);
  paint();
  group.segValue = () => current;
  return group;
}

// ---------- Sheets ----------
// One shell (index.html #sheet): a grabber, a title row, a scrolling body and a footer.
// openSheet(...kids) fills it. A leading <h3> (or the first child of a leading wrapper) becomes
// the title; a primary `.go` button, with the buttons right after it, moves to the footer; a
// sheet with a field opens large, others medium. An options object first overrides:
// { size: 'medium' | 'large', replace: true, grouped: true }. A grouped sheet (Settings and its
// pages, the session menu) is the page colour, so its card-surface groups read as inset lists.
// While a sheet is open, opening one with another title pushes it: the title row shows Back,
// which returns to the one below as it was. Opening the same title again (a reload or a
// redraw) replaces it in place, and opening a title already in the stack goes back to it.
// The sheet traps focus while open and hands it back to whatever opened it.
const sheetStack = [];
let sheetCur = { title: '', heading: null };
let sheetReturn = null;
const isEl = (n) => !!n && n.nodeType === 1;
const hasClass = (n, c) => isEl(n) && String(n.className || '').split(/\s+/).includes(c);
function sheetHeading(nodes) {
  const first = nodes.find(isEl);
  if (!first) return null;
  if (first.tagName === 'H3') return first;
  const inner = [...(first.childNodes || [])].find(isEl);
  return inner && inner.tagName === 'H3' ? inner : null;
}
function sheetHasField(nodes) {
  return nodes.some((n) => isEl(n) && ((typeof n.matches === 'function' && n.matches('input, textarea, select'))
    || (typeof n.querySelector === 'function' && n.querySelector('input, textarea, select'))));
}
function paintSheet(st) {
  const sheet = $('#sheet'), body = $('#sheetBody'), foot = $('#sheetFoot');
  $('#sheetTitle').replaceChildren(...(st.heading ? [st.heading] : []));
  body.replaceChildren(...st.body);
  foot.replaceChildren(...st.foot);
  foot.hidden = !st.foot.length;
  sheet.setAttribute('data-size', st.size);
  if (st.grouped) sheet.setAttribute('data-grouped', ''); else sheet.removeAttribute('data-grouped');
  // A footer with a primary action makes this a form: the way out is Cancel, not Done.
  $('#sheetClose').textContent = st.foot.some((n) => hasClass(n, 'go')) ? 'Cancel' : 'Done';
  $('#sheetBack').hidden = !sheetStack.length;
  body.scrollTop = st.scroll || 0;
  sheetCur = { title: st.title, heading: st.heading };
}
function sheetSnapshot() {
  const sheet = $('#sheet'), body = $('#sheetBody');
  return {
    title: sheetCur.title, heading: sheetCur.heading,
    body: [...(body.childNodes || [])], foot: [...($('#sheetFoot').childNodes || [])],
    size: sheet.getAttribute('data-size') || 'medium', scroll: body.scrollTop,
    grouped: sheet.getAttribute('data-grouped') != null,
  };
}
// Keep focus in the sheet: on the sheet itself unless something inside already has it.
function focusSheet() {
  const sheet = $('#sheet'), a = document.activeElement;
  if (a && a !== sheet && typeof sheet.contains === 'function' && sheet.contains(a)) return;
  if (typeof sheet.focus === 'function') sheet.focus({ preventScroll: true });
}
function setSheetInert(on) { $('#listView').inert = on; $('#chatView').inert = on; }

// ----- Sheet motion -----
// The sheet rises with a CSS animation (style.css). Everything after that is here: a drag that
// follows the finger, the 220ms dismissal, the spring back, and a sheet caught while it is still
// rising. Closing is logical at once (the stack, the inert views and focus are settled before the
// sheet has left the screen) and visual over 220ms; `sheetClosing` covers that gap, so code that
// asks whether a sheet is open asks sheetOpen(), not `hidden`.
let sheetClosing = false;
let sheetMotion = []; // the running sheet and scrim animations
function sheetOpen() { return !$('#sheet').hidden && !sheetClosing; }
// How far down the sheet is drawn right now: mid-rise, mid-drag, mid-spring or at rest. A
// layout read, made once at the start of a gesture or a close, never per frame.
function sheetOffset() {
  const sheet = $('#sheet');
  if (typeof getComputedStyle !== 'function') return 0;
  const tf = getComputedStyle(sheet).transform;
  if (!tf || tf === 'none') return 0;
  try { if (typeof DOMMatrixReadOnly === 'function') return Math.max(0, new DOMMatrixReadOnly(tf).m42); } catch {}
  const m = /matrix(3d)?\(([^)]+)\)/.exec(tf);
  if (!m) return 0;
  const v = m[2].split(',').map(Number);
  return Math.max(0, (m[1] ? v[13] : v[5]) || 0);
}
function scrimOpacity() {
  const scrim = $('#scrim');
  if (typeof getComputedStyle !== 'function') return 1;
  const o = Number(getComputedStyle(scrim).opacity);
  return Number.isFinite(o) ? o : 1;
}
// Stop whatever is moving the sheet and leave it drawn where it is, held by inline style.
function holdSheet() {
  const sheet = $('#sheet'), scrim = $('#scrim');
  const y = sheetOffset(), o = scrimOpacity();
  for (const a of sheetMotion) { try { a.cancel(); } catch {} }
  sheetMotion = [];
  sheet.classList.add('held'); scrim.classList.add('held');
  placeSheet(y, o);
  return y;
}
function placeSheet(y, scrimO) {
  const sheet = $('#sheet'), scrim = $('#scrim');
  sheet.style.transform = y > 0 ? `translateY(${y}px)` : '';
  scrim.style.opacity = scrimO >= 1 ? '' : String(Math.max(0, scrimO));
}
function releaseSheet() {
  const sheet = $('#sheet'), scrim = $('#scrim');
  for (const a of sheetMotion) { try { a.cancel(); } catch {} }
  sheetMotion = [];
  sheet.style.transform = ''; scrim.style.opacity = '';
  // .held stays until the sheet is hidden: dropping it while shown would replay the rise.
  if (sheet.hidden) { sheet.classList.remove('held'); scrim.classList.remove('held'); }
}
// Take the sheet off screen: 220ms down on the exit curve (a 120ms fade under Reduce Motion),
// from wherever it is. `fromY` is the drag's own last offset when a drag let go of it.
function hideSheet(fromY) {
  const sheet = $('#sheet'), scrim = $('#scrim');
  const gone = () => {
    sheetClosing = false;
    sheet.hidden = true; scrim.hidden = true; sheet.inert = false;
    releaseSheet();
  };
  if (sheet.hidden || !canAnimate(sheet) || !canAnimate(scrim)) { gone(); return; }
  const o = scrimOpacity();
  const held = holdSheet();
  const y = fromY == null ? held : fromY;
  sheetClosing = true;
  sheet.inert = true; // nothing in a leaving sheet can be focused or pressed
  const at = `translateY(${y}px)`;
  const opts = (ms, easing) => ({ duration: ms, easing, fill: 'forwards' });
  sheetMotion = reducedMotion()
    ? [sheet.animate([{ transform: at, opacity: 1 }, { transform: at, opacity: 0 }], opts(MOTION.fast, 'linear')),
      scrim.animate([{ opacity: o }, { opacity: 0 }], opts(MOTION.fast, 'linear'))]
    : [sheet.animate([{ transform: at }, { transform: 'translateY(100%)' }], opts(MOTION.base, MOTION.exit)),
      scrim.animate([{ opacity: o }, { opacity: 0 }], opts(MOTION.base, MOTION.exit))];
  sheetMotion[0].onfinish = gone;
}
// A closing sheet that is asked to open again stops leaving and opens fresh.
function stopHidingSheet() {
  if (!sheetClosing) return;
  const sheet = $('#sheet'), scrim = $('#scrim');
  sheetClosing = false;
  sheet.hidden = true; scrim.hidden = true; sheet.inert = false;
  releaseSheet();
}
// Back to the sheet's resting place: 320ms on the emphasized curve, like the rise it interrupted.
function settleSheet(fromY) {
  const sheet = $('#sheet'), scrim = $('#scrim');
  const o = scrimOpacity();
  if (!fromY || !canAnimate(sheet) || reducedMotion()) { releaseSheet(); return; }
  placeSheet(0, 1);
  const opts = { duration: MOTION.slow, easing: MOTION.emphasized };
  sheetMotion = [sheet.animate([{ transform: `translateY(${fromY}px)` }, { transform: 'translateY(0)' }], opts),
    scrim.animate([{ opacity: o }, { opacity: 1 }], opts)];
  sheetMotion[0].onfinish = () => { sheetMotion = []; };
}
// A sub-sheet slides its title and body in from the right (Back: from the left), 220ms. The
// title row's buttons and the footer change in place.
function slideSheet(dir) {
  const parts = [$('#sheetTitle'), $('#sheetBody')];
  if (!parts.every(canAnimate)) return;
  const reduce = reducedMotion();
  const from = reduce ? { opacity: 0 } : { transform: `translateX(${dir === 'back' ? -24 : 24}px)`, opacity: 0 };
  const to = reduce ? { opacity: 1 } : { transform: 'translateX(0)', opacity: 1 };
  for (const el of parts) el.animate([from, to], { duration: reduce ? MOTION.fast : MOTION.base, easing: reduce ? 'linear' : MOTION.standard });
}

function openSheet(...kids) {
  const opts = kids.length && kids[0] && typeof kids[0] === 'object' && !kids[0].nodeType && !Array.isArray(kids[0]) ? kids.shift() : {};
  let nodes = kids.flat().filter((k) => k != null && k !== false);
  const sheet = $('#sheet');
  const heading = sheetHeading(nodes);
  const title = heading ? String(heading.textContent || '').trim() : '';
  stopHidingSheet();
  let slide = null;
  if (sheet.hidden) {
    sheetStack.length = 0;
    const a = document.activeElement;
    sheetReturn = a && a !== document.body ? a : null;
  } else if (!opts.replace && title !== sheetCur.title) {
    const back = sheetStack.findIndex((e) => e.title === title);
    if (back >= 0) sheetStack.length = back;
    else sheetStack.push(sheetSnapshot());
    slide = back >= 0 ? 'back' : 'forward';
  }
  if (heading) nodes = nodes.filter((n) => n !== heading);
  let foot = [];
  const go = nodes.findIndex((n) => hasClass(n, 'go'));
  if (go >= 0) {
    let end = go + 1;
    while (end < nodes.length && isEl(nodes[end]) && nodes[end].tagName === 'BUTTON') end++;
    foot = nodes.slice(go, end);
    nodes = nodes.slice(0, go).concat(nodes.slice(end));
  }
  const size = opts.size || (sheetHasField(nodes.concat(foot)) ? 'large' : 'medium');
  paintSheet({ title, heading, body: nodes, foot, size, scroll: 0, grouped: !!opts.grouped });
  $('#scrim').hidden = false; sheet.hidden = false;
  if (slide) slideSheet(slide);
  setSheetInert(true);
  focusSheet();
}
// Back to the sheet below, exactly as it was left.
function sheetBack() {
  if (!sheetOpen()) return;
  const prev = sheetStack.pop();
  if (!prev) { closeSheet(); return; }
  paintSheet(prev);
  slideSheet('back');
  focusSheet();
}
// `fromY`: where a drag let go of it, so the dismissal carries on from the finger.
function closeSheet(fromY) {
  const sheet = $('#sheet');
  const wasOpen = sheetOpen();
  if (!wasOpen) { if (sheet.hidden) $('#scrim').hidden = true; return; }
  hideSheet(typeof fromY === 'number' ? fromY : null);
  sheetStack.length = 0;
  sheetCur = { title: '', heading: null };
  setSheetInert(false);
  const back = sheetReturn;
  sheetReturn = null;
  if (!wasOpen || !back || !back.isConnected || typeof back.focus !== 'function') return;
  // Hand focus back to whatever opened the sheet, even a text field: a sheet is a modal detour,
  // and the plan requires focus to return to the trigger. Returning to an editor may raise the
  // iOS keyboard again, which is the browser's native behaviour and the right one here.
  const a = document.activeElement;
  const lost = !a || a === document.body || (typeof sheet.contains === 'function' && sheet.contains(a));
  if (lost) back.focus({ preventScroll: true });
}
$('#scrim').addEventListener('click', closeSheet);
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheetBack').addEventListener('click', sheetBack);
const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
document.addEventListener('keydown', (e) => {
  const sheet = $('#sheet');
  if (!sheetOpen()) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab' || typeof sheet.querySelectorAll !== 'function') return;
  // A focus trap: Tab and Shift-Tab wrap inside the sheet (the views behind are inert too).
  const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.getClientRects().length);
  if (!items.length) { e.preventDefault(); sheet.focus(); return; }
  const first = items[0], last = items[items.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || a === sheet || !sheet.contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (a === last || !sheet.contains(a))) { e.preventDefault(); first.focus(); }
});
// Drag to dismiss. A drag starts on the header, or anywhere in the body when nothing under the
// finger is scrolled away from its top; in the body it is claimed only once the finger has
// moved 6px and mostly downward, so an upward or sideways move stays the body's (or a code
// block's) own scroll. From then on the sheet follows the finger 1:1 from where it came down,
// with resistance past 120px, and the scrim thins with it. Let go past 30% of the sheet's
// height, or with a downward flick, and it leaves over 220ms; otherwise it springs back. A sheet
// still rising can be caught: a finger anywhere on it stops it where it is, and a drag carries
// on from there (let go without dragging and it carries on up). Under Reduce Motion the drag still follows the finger (it is the user's own
// movement, and how a sheet is swiped away) but the exit is a fade and the return is
// immediate. Touch for fingers; a mouse can drag the header.
(() => {
  const sheet = $('#sheet');
  const SLOP = 6, RESIST = 120, DISMISS = 0.3, FLICK = 0.5; // px, px, share of height, px/ms
  let g = null; // the gesture: { x0, y0, base, h, claimed, y, samples, mouse }
  const near = (n, sel) => (n && typeof n.closest === 'function' ? n.closest(sel) : null);
  // Anything between the touch and the sheet that is scrolled down keeps the gesture.
  const scrolledUnder = (n) => { for (; n && n !== sheet; n = n.parentNode) if (n.scrollTop > 0) return true; return false; };
  // Is something (the rise, a spring, a fade) moving the sheet right now?
  const moving = () => sheetMotion.length > 0 || (typeof sheet.getAnimations === 'function' && sheet.getAnimations().length > 0);
  function begin(x, y, target, mouse) {
    g = null;
    if (!sheetOpen()) return;
    const onHead = near(target, '.sheethead');
    if (mouse && (!onHead || near(target, 'button'))) return;
    if (!onHead && (near(target, 'input, textarea, select, [contenteditable]') || scrolledUnder(target))) return;
    g = { x0: x, y0: y, base: 0, h: 1, claimed: false, moved: false, y: 0, samples: [], mouse };
    // A finger that lands on the sheet while it is moving (still rising, or springing back)
    // catches it there and then, rather than after the first few pixels of travel. Nothing in
    // it can be mid-scroll yet, so there is no scroll to take the gesture from.
    if (!mouse && moving()) claim();
  }
  function claim() {
    g.claimed = true;
    g.base = g.y = holdSheet();
    const r = typeof sheet.getBoundingClientRect === 'function' ? sheet.getBoundingClientRect() : null;
    g.h = Math.max(1, (r && r.height) || sheet.offsetHeight || 1); // a translate leaves the height alone
  }
  function track(y, t) {
    // 1:1 from where the finger came down; past 120px (or past where a moving sheet was caught,
    // if that is lower) it moves at half speed.
    const raw = Math.max(0, g.base + (y - g.y0));
    const limit = Math.max(RESIST, g.base);
    g.y = raw <= limit ? raw : limit + (raw - limit) * 0.5;
    g.samples.push({ t, y: g.y });
    while (g.samples.length > 2 && t - g.samples[0].t > 100) g.samples.shift();
    placeSheet(g.y, 1 - g.y / g.h);
  }
  function move(x, y, t, e) {
    if (!g) return;
    const dx = x - g.x0, dy = y - g.y0;
    if (!g.moved) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return; // still a tap: leave it to click
      if (!g.claimed && (dy <= 0 || Math.abs(dx) > Math.abs(dy))) { g = null; return; } // the content's scroll, not ours
      g.moved = true;
      if (!g.claimed) claim();
    }
    if (e && e.cancelable) e.preventDefault(); // the body must not scroll under a drag
    track(y, t);
  }
  function end(cancelled) {
    const was = g; g = null;
    if (!was || !was.claimed) return;
    const s = was.samples, first = s[0], last = s[s.length - 1];
    const v = first && last && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    // A sheet caught mid-rise and let go without a drag carries on up: that was a touch, not a
    // dismissal, however low it was caught.
    const away = !cancelled && was.moved && v > -0.1 && (was.y > was.h * DISMISS || (v > FLICK && was.y > 16));
    if (away) closeSheet(was.y); else settleSheet(was.y);
  }
  const now = (e) => (e && typeof e.timeStamp === 'number' ? e.timeStamp : Date.now());
  sheet.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length !== 1) { if (g && g.claimed) end(true); g = null; return; }
    begin(e.touches[0].clientX, e.touches[0].clientY, e.target, false);
  }, { passive: true });
  // Not passive: once a drag has the gesture it must stop the body scrolling under it. Before
  // that, and for every touch that is not a drag, it returns without a layout read.
  sheet.addEventListener('touchmove', (e) => {
    if (!g || g.mouse || !e.touches || !e.touches[0]) return;
    move(e.touches[0].clientX, e.touches[0].clientY, now(e), e);
  }, { passive: false });
  sheet.addEventListener('touchend', () => { if (g && !g.mouse) end(false); }, { passive: true });
  sheet.addEventListener('touchcancel', () => { if (g && !g.mouse) end(true); }, { passive: true });
  sheet.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    begin(e.clientX, e.clientY, e.target, true);
    if (g && typeof sheet.setPointerCapture === 'function') { try { sheet.setPointerCapture(e.pointerId); } catch {} }
  });
  sheet.addEventListener('pointermove', (e) => { if (g && g.mouse) move(e.clientX, e.clientY, now(e), null); });
  sheet.addEventListener('pointerup', () => { if (g && g.mouse) end(false); });
  sheet.addEventListener('pointercancel', () => { if (g && g.mouse) end(true); });
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
function templatesSheet(sel) {
  // Remember the cursor up front: opening the sheet blurs the composer and
  // some browsers drop the selection on blur. The plus menu hands in the caret it
  // read before its own sheet took focus.
  const [a, b] = Array.isArray(sel) ? sel : [input.selectionStart, input.selectionEnd];
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
  const path = h('input', { type: 'text', class: 'mono', id: 'newPath', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'folders' });
  const preset = h('select', { id: 'newPreset' });
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
    h('label', { for: 'newPath' }, 'Folder'), path, list,
    h('label', { for: 'newPreset' }, 'Agent preset'), preset, go);
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

// The session menu: what acts on this session, then Settings, then Archive on its own. App-wide
// things (notifications, appearance, plugins, prices, the full dsh UI) live in Settings;
// Commands is in the composer's plus menu and Refresh in Session details.
function sessionMenuSheet() {
  const cur = S.cur; if (!cur) return;
  const goal = dsh2 ? goalFor(cur.id) : null;
  const route = routeFor(cur);
  openSheet({ grouped: true }, h('h3', {}, $('#title').textContent),
    setGroup({ label: 'This session' },
      setRow('Session details', { onclick: sessionDetailsSheet }),
      setRow('Model', { onclick: modelSheet, value: route && route.model }),
      dsh2 ? setRow('Goal', { onclick: () => goalSheet(), value: goal ? window.dsh02.goalStatus(goal).text : 'None' }) : null,
      window.dshSchedulesUI && window.dshSchedulesUI.menuItem(), // per session, so in this menu
      setRow('Rename', { onclick: renameSheet }),
      setRow('Fork', { onclick: forkSession, chevron: false }),
      setRow('Export log', { onclick: exportSheet })),
    setGroup({ label: 'App' }, setRow('Settings', { onclick: settingsSheet })),
    // Destructive, so last and alone; its sheet names what it does before anything happens.
    setGroup({ label: 'Archive' }, setRow('Archive', { onclick: archiveSheet, tone: 'danger', chevron: false })));
}
$('#menuBtn').onclick = sessionMenuSheet;
// ---------- Plugins (read-only) ----------
// Both APIs answer `pluginInventory/list` (the pluginInventory Typert namespace). The 0.2
// snapshot also carries display metadata and agent-preset compositions; dsh02.js resolves
// those into the rows below, and a 0.1 snapshot simply has neither. dsh-plugin-manager does
// offer per-entry enable/disable (`pluginManager/setPluginEnabled`), but dsh-rc's proxy
// refuses the whole `pluginManager` namespace, so the phone cannot change the profile and
// this screen stays read-only.
async function pluginsSheet() {
  const page = { size: 'large', grouped: true };
  openSheet(page, h('h3', {}, 'Plugins & connectors'), h('p', { class: 'set-foot set-foot-alone' }, 'Loading…'));
  let snap;
  try {
    const v = await remote('pluginInventory/list', {});
    snap = window.dsh02 && window.dsh02.fromPluginInventory
      ? window.dsh02.fromPluginInventory(v, { locale: navigator.language })
      : { entries: (v && (v.entries || v.items)) || (Array.isArray(v) ? v : []), presets: [], managementAvailable: false };
  } catch (e) { openSheet(page, h('h3', {}, 'Plugins & connectors'), setError('Could not read the plugin list.', e.message)); return; }
  const entries = snap.entries;
  const phase = (e) => e.fiberPhase ?? e.phase ?? null;
  const shortId = (e) => String(e.entryId || '').split(':').pop();
  // The Loader entry id is the scannable identity; prefer a display title only when the
  // package published one that says more than the module specifier.
  const name = (e) => (e.title && e.title !== e.moduleName ? e.title : shortId(e));
  const state = (e) => !e.enabled ? 'off' : (phase(e) === 'failed' ? 'failed' : (phase(e) && phase(e) !== 'active' ? phase(e) : 'on'));
  const row = (e, label) => {
    const st = state(e);
    return h('div', { class: 'plug' },
      statusGlyph(itemGlyph(st), 'pdot'),
      h('div', { class: 'pmain' }, h('b', {}, label || name(e)),
        e.description ? h('small', { class: 'pdesc' }, e.description) : (e.moduleName ? h('small', {}, e.moduleName) : null)),
      h('span', { class: 'pstate ' + st }, st));
  };
  const mcp = entries.filter((e) => /dsh-mcp-client/.test(e.moduleName || ''));
  const subs = entries.filter((e) => /dsh-subagent-(claude-code|codex|acp|dsh-sdk)/.test(e.moduleName || '') && !/tool-/.test(e.entryId));
  const bad = entries.filter((e) => e.enabled && phase(e) === 'failed');
  const all = entries.filter((e) => e.moduleName && !/^cordis:/.test(e.moduleName));
  const list = h('div', { class: 'set-group plist' });
  const search = h('input', { type: 'search', placeholder: `Search ${all.length} plugins`, autocomplete: 'off', 'aria-label': 'Search plugins' });
  const renderAll = () => {
    const q = search.value.trim().toLowerCase();
    const hits = all.filter((e) => !q || [e.entryId, e.moduleName, e.title, e.description].filter(Boolean).join(' ').toLowerCase().includes(q));
    list.replaceChildren(...(hits.length ? hits.slice(0, 200).map((e) => row(e)) : [h('div', { class: 'set-row static' }, h('span', { class: 'set-label quiet' }, 'No plugin matches'))]));
  };
  search.oninput = renderAll;
  // Each list is one grouped card under a 13px header; the rows keep their glyph and state word.
  const section = (title, items, label) => items.length ? [setGroup({ head: title }, ...items.map((e) => row(e, label && label(e))))] : [];
  // A preset's composition is the 0.2 snapshot's other half: a broken or failing one cannot
  // mount a session, so it sorts before the healthy presets and the default one.
  const badness = (p) => (p.broken ? 2 : p.failed ? 1 : 0);
  const presets = (snap.presets || []).slice().sort((a, b) => (badness(b) - badness(a)) || (Number(b.isDefault) - Number(a.isDefault)));
  const presetRow = (p) => {
    const st = p.broken || p.failed ? 'failed' : 'on';
    const detail = p.broken || `${p.rows.length} plugin${p.rows.length === 1 ? '' : 's'}${p.failed ? `, ${p.failed} failed` : ''}`;
    return h('div', { class: 'plug' },
      statusGlyph(itemGlyph(st), 'pdot'),
      h('div', { class: 'pmain' }, h('b', {}, p.name + (p.isDefault ? ' · default' : '')), h('small', { class: 'pdesc' }, detail)),
      h('span', { class: 'pstate ' + st }, p.broken ? 'broken' : (p.failed ? `${p.failed} failed` : '')));
  };
  openSheet(page,
    h('h3', {}, 'Plugins & connectors'),
    bad.length ? setError(`${bad.length} plugin${bad.length > 1 ? 's' : ''} failed to load.`) : null,
    ...section('Failed', bad),
    ...section('Connectors (MCP)', mcp, (e) => shortId(e).replace(/^mcp-/, '')),
    ...section('Subagent providers', subs, (e) => shortId(e).replace(/^subagent-/, '')),
    ...(presets.length ? [setGroup({ head: 'Presets' }, ...presets.map(presetRow))] : []),
    h('section', { class: 'set-sec' }, h('h4', { class: 'set-head' }, 'All plugins'), search, list,
      h('p', { class: 'set-foot' }, snap.managementAvailable
        ? 'Read-only. This profile supports plugin changes; dsh-rc leaves them to the laptop.'
        : 'Read-only. Plugins and connectors are added on the laptop in the dsh profile, then dsh restarts.')));
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
            await loadModel(cur.id); // refresh the route shown in the header and details
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
// It lives under Settings > Advanced: a developer tool, kept as JSON in the machine face, with
// Save in the sheet's sticky footer.
function pricesSheet() {
  const lib = window.dshPrices;
  const page = { size: 'large', grouped: true };
  if (!lib) {
    openSheet(page, h('h3', {}, 'Prices'), setError('The price table did not load, so estimated cost stays “n/a”.'));
    return;
  }
  const saved = priceOverrides();
  const box = h('textarea', { rows: '9', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', 'aria-label': 'Price overrides as JSON', class: 'prices-json' });
  box.value = Object.keys(saved).length ? JSON.stringify(saved, null, 2) : '';
  const errSlot = h('div', { class: 'set-note-slot', 'aria-live': 'polite' });
  const save = h('button', { type: 'button', class: 'go' }, 'Save prices');
  const clear = h('button', { type: 'button', class: 'ghost wide' }, 'Clear overrides');
  save.onclick = () => {
    let rows;
    errSlot.replaceChildren();
    try { rows = lib.parsePriceOverrides(box.value); }
    catch (e) { errSlot.replaceChildren(setError('Those prices are not valid yet.', e.message)); return; }
    if (!lib.savePriceOverrides(rows)) { errSlot.replaceChildren(setError('Could not save.', 'This browser refused storage.')); return; }
    S.prices = rows; // the renderer caches reads, so hand it the new rows
    renderStatusLine();
    toast(Object.keys(rows).length ? 'Prices saved' : 'Overrides cleared');
    if (settingsVals.prices) settingsVals.prices.textContent = pricesValue();
    sheetBack(); // back to Settings, or closed if Prices was the only sheet
  };
  clear.onclick = () => { box.value = ''; save.onclick(); };
  openSheet(page, h('h3', {}, 'Prices'),
    h('p', { class: 'set-foot set-foot-alone' }, 'USD per million tokens, as JSON keyed by model-id prefix. The longest matching prefix wins, and an override beats the built-in table. Blank clears them.'),
    h('p', { class: 'set-foot set-foot-alone' }, 'Fields: input, output, cacheRead, cacheWrite.'),
    box, errSlot, save, clear);
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
// The browser's own permission, in words. 'default' means it has not asked yet.
function permissionLabel() {
  const p = typeof Notification !== 'undefined' ? Notification.permission : null;
  return p === 'granted' ? 'Allowed' : p === 'denied' ? 'Blocked' : p ? 'Not asked yet' : 'Not available';
}
// A switch: the native one where Safari 17.4+ draws it (`<input type=checkbox switch>`), a styled
// 44 by 28 one elsewhere. Either way it is a checkbox with the switch role. Safari's switch
// pseudo-elements are the feature test; no browser exposes a property for the attribute.
const NATIVE_SWITCH = (() => {
  try {
    if (typeof CSS === 'undefined' || !CSS.supports || !CSS.supports('selector(input[switch]::thumb)')) return false;
    const m = String((typeof navigator !== 'undefined' && navigator.userAgent) || '').match(/Version\/(\d+)\.(\d+).*Safari/);
    return !!m && (+m[1] > 17 || (+m[1] === 17 && +m[2] >= 4));
  } catch { return false; }
})();
function switchInput(attrs = {}) {
  const el = h('input', { type: 'checkbox', switch: true, role: 'switch', ...attrs });
  if (!NATIVE_SWITCH) el.classList.add('switch-fb');
  return el;
}
// Notifications: one switch for this device, the permission the browser holds, what sends a
// push, the Home Screen steps on iOS, and a test. Turning on runs inside the tap (iOS grants
// the permission only from a user gesture); a refusal or an error puts the switch back and
// says why, here, rather than in a toast.
async function notificationsSheet() {
  const sw = switchInput({ id: 'pushSwitch', 'aria-describedby': 'pushState' });
  const state = h('p', { class: 'set-foot', id: 'pushState' }, 'Checking…');
  const errSlot = h('div', { class: 'set-note-slot', 'aria-live': 'polite' });
  const testSlot = h('div', { class: 'set-note-slot' });
  const perm = h('span', { class: 'set-val' }, permissionLabel());
  // A real button, so it is reachable by keyboard and VoiceOver and its disabled state holds
  // off a second send while the first is in flight.
  const testRow = setRow('Send a test', { tone: 'action', chevron: false, onclick: async () => {
    testRow.disabled = true; testSlot.replaceChildren();
    try { await sendTestPush(); toast('Test notification sent'); }
    catch (e) { testSlot.replaceChildren(setError('The test was not sent.', e.message)); }
    finally { testRow.disabled = false; }
  } });
  const testGroup = setGroup({ foot: 'Sends one notification to every device that has them on.' }, testRow);
  const iosSteps = isIOS() && !isStandalone();
  let busy = false;
  sw.disabled = true;
  const paint = (st, note) => {
    sw.checked = st === 'on';
    const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
    sw.disabled = busy || st === 'unsupported' || (denied && st !== 'on');
    perm.textContent = permissionLabel();
    state.textContent = note || (st === 'unsupported'
      ? (iosSteps ? 'Not available in a Safari tab. Add dsh-rc to the Home Screen first (below).' : 'This browser does not support push notifications.')
      : denied && st !== 'on' ? 'The browser has blocked notifications for this site. Allow them in its site settings, then come back.'
        : st === 'on' ? 'On for this device.' : 'Off for this device.');
    testGroup.hidden = st !== 'on';
    if (settingsVals.notif) settingsVals.notif.textContent = pushStateShort(st);
  };
  // Inside the change event, before any await: enablePush asks for permission first thing.
  sw.addEventListener('change', () => {
    const want = sw.checked;
    busy = true; sw.disabled = true; errSlot.replaceChildren(); testSlot.replaceChildren();
    state.textContent = want ? 'Turning on… approve the browser’s prompt.' : 'Turning off…';
    (want ? enablePush() : disablePush()).then(() => {
      busy = false; paint(want ? 'on' : 'off');
      toast(want ? 'Notifications on' : 'Notifications off');
    }, async (e) => {
      busy = false;
      const st = await refreshPushState().catch(() => 'off');
      paint(st);
      errSlot.replaceChildren(setError(
        want ? (/permission/.test(e.message) ? 'The browser did not allow notifications.' : 'Could not turn notifications on.') : 'Could not turn notifications off.',
        e.message));
    });
  });
  const steps = iosSteps ? setGroup({ head: 'On iPhone and iPad', foot: 'iOS 16.4 or newer, over HTTPS. Notifications only reach a web app opened from the Home Screen.' },
    h('ol', { class: 'set-steps' },
      h('li', {}, 'In Safari, tap Share.'),
      h('li', {}, 'Choose Add to Home Screen, then Add.'),
      h('li', {}, 'Open dsh-rc from the Home Screen and turn notifications on here.'))) : null;
  openSheet({ size: 'large', grouped: true }, h('h3', {}, 'Notifications'),
    h('section', { class: 'set-sec' },
      h('div', { class: 'set-group' },
        h('label', { class: 'set-row switch-row', for: 'pushSwitch' }, h('span', { class: 'set-label' }, 'Allow notifications'), sw),
        setRow('Browser permission', { value: perm })),
      state, errSlot),
    testGroup, testSlot,
    setGroup({ head: 'What sends a push', foot: 'Subagent sessions never notify. A notification names the session when dsh knows its title, and tapping it opens that session.' },
      h('ul', { class: 'set-steps set-bullets' },
        h('li', {}, 'An approval is waiting.'),
        h('li', {}, 'A question is waiting.'),
        h('li', {}, 'A turn finishes.'),
        h('li', {}, 'An error arrives from the agent.'))),
    steps);
  paint(await refreshPushState().catch(() => 'off'));
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
  // Copy, and Share where the browser has the share sheet. A cancelled share is not an error.
  const copy = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Copy');
  copy.onclick = () => copyText(url, copy);
  const share = typeof navigator.share === 'function' ? h('button', { type: 'button', class: 'btn btn-secondary' }, 'Share') : null;
  if (share) share.onclick = () => { navigator.share({ title: 'dsh-rc', url }).catch(() => {}); };
  openSheet({ size: 'large', grouped: true }, h('h3', {}, 'Open on your phone'),
    h('p', { class: 'set-foot set-foot-alone' }, tile ? 'Scan with the phone camera. You still log in with the passphrase.' : 'Open this address on your phone. You still log in with the passphrase.'),
    tile,
    h('div', { class: 'note url' }, url),
    h('div', { class: 'qr-acts' }, copy, share),
    h('p', { class: 'set-foot set-foot-alone' }, 'The address changes every time dsh-rc starts with --tunnel.'));
}

// ---------- Settings ----------
// One app-wide destination, from the gear on the Sessions bar or Settings in the session menu.
// Grouped inset rows on the card surface: a label, a 13px value and a chevron when the row
// opens a page, which pushes inside the same sheet. What a group is for goes in one quiet
// footer under it, not in a subtitle on every row.
// The release workflow bumps the version here with package.json (release-please-config.json,
// extra-files), and test/settings.test.mjs keeps the two equal. There is no server version
// endpoint; this is the version of the page you are looking at.
const APP_VERSION = '0.4.1'; // x-release-please-version
const SOURCE_URL = 'https://github.com/Matthew3957/dsh-rc';
// The values on the open Settings page, so a page below it can update them in place before
// Back shows them again.
let settingsVals = {};
const CHEVRON = () => h('span', { class: 'set-chev', 'aria-hidden': 'true' });
// A group: an optional header above, the rows on one card, an optional footer below. Empty
// groups (every row conditional and absent) are left out.
function setGroup({ head, foot, label } = {}, ...rows) {
  const kids = rows.flat().filter((k) => k != null && k !== false);
  if (!kids.length) return null;
  return h('section', { class: 'set-sec', 'aria-label': head ? null : (label || null) },
    head ? h('h4', { class: 'set-head' }, head) : null,
    h('div', { class: 'set-group' }, ...kids),
    foot ? (foot.nodeType ? foot : h('p', { class: 'set-foot' }, foot)) : null);
}
// A row. onclick makes it a button (with a chevron unless chevron: false), href a link; with
// neither it is a plain label and value. tone: 'action' (accent text) or 'danger' (red text).
function setRow(label, { value, onclick, href, external = false, chevron, tone } = {}) {
  const cls = 'set-row' + (tone ? ' ' + tone : '');
  const val = value == null ? null : (value.nodeType ? value : h('span', { class: 'set-val' }, String(value)));
  const chev = chevron ?? (!!onclick || (!!href && !external));
  const kids = [h('span', { class: 'set-label' }, label), val,
    external ? h('span', { class: 'set-ext', 'aria-hidden': 'true' }) : (chev ? CHEVRON() : null)];
  if (href) return h('a', { class: cls, href, target: external ? '_blank' : null, rel: external ? 'noopener' : null }, ...kids);
  if (onclick) return h('button', { type: 'button', class: cls, onclick }, ...kids);
  return h('div', { class: cls + ' static' }, ...kids);
}
// An inline error where the work is: a human sentence, then the technical message in 13px.
function setError(sentence, detail) {
  return h('div', { class: 'set-error', role: 'alert' }, statusGlyph('failed'),
    h('div', {}, h('p', {}, sentence), detail ? h('p', { class: 'set-error-detail' }, detail) : null));
}
function themeLabel() {
  const t = window.dshTheme;
  const cur = t && t.THEMES.find((x) => x.id === t.current());
  return cur ? cur.label : 'Default';
}
function pricesValue() {
  if (!window.dshPrices) return 'Unavailable';
  const n = Object.keys(priceOverrides()).length;
  return n ? `${n} override${n === 1 ? '' : 's'}` : 'Built-in';
}
function pushStateShort(state) {
  return state === 'on' ? 'On' : state === 'unsupported' ? 'Not supported' : 'Off';
}
// The full dsh web UI is at the origin's root, which only exists when dsh-rc is mounted on a path
// beside it (Tailscale Serve); dsh-rc's own front door has nothing there.
const fullUiAvailable = () => !!location.pathname.replace(/\/+$/, '');
function settingsSheet() {
  const notif = h('span', { class: 'set-val' }, '');
  refreshPushState().then((st) => { notif.textContent = pushStateShort(st); }).catch(() => { notif.textContent = 'Off'; });
  const theme = h('span', { class: 'set-val' }, themeLabel());
  const prices = h('span', { class: 'set-val' }, pricesValue());
  settingsVals = { notif, theme, prices };
  const openTunnel = () => { tunnelSheet().catch((e) => toast('Tunnel address unavailable: ' + e.message)); };
  openSheet({ size: 'large', grouped: true }, h('h3', {}, 'Settings'),
    setGroup({ label: 'Notifications and appearance', foot: 'Both are per device. Appearance is saved in this browser.' },
      setRow('Notifications', { onclick: () => notificationsSheet(), value: notif }),
      window.dshTheme ? setRow('Appearance', { onclick: appearanceSheet, value: theme }) : null),
    setGroup({ head: 'dsh', foot: 'What the dsh on your laptop has loaded. Read-only here: add or change them in the dsh profile.' },
      setRow('Plugins & connectors', { onclick: pluginsSheet })),
    setGroup({ head: 'This device', foot: 'Show this page’s tunnel address as a QR code, so another phone can scan it. It still asks for the passphrase.' },
      S.tunnelUrl ? setRow('Open on your phone', { onclick: openTunnel, value: 'QR code' }) : null),
    setGroup({ head: 'Advanced', foot: 'The price table behind “est. cost”, as JSON.' },
      setRow('Prices', { onclick: pricesSheet, value: prices })),
    setGroup({ head: 'About', foot: 'dsh-rc is an independent project, not affiliated with or endorsed by DeepSeek.' },
      setRow('Version', { value: h('span', { class: 'set-val mono-val' }, APP_VERSION) }),
      fullUiAvailable() ? setRow('Open full dsh web UI', { href: '/' }) : null,
      setRow('Source code', { href: SOURCE_URL, external: true, value: 'GitHub' })));
}
$('#settingsBtn').onclick = settingsSheet;

// Appearance: a card per theme, each a split swatch of the light and the dark scheme (page, a
// card and the accent) and the theme's name. The selected card has a ring and a check, so the
// choice is never colour alone. Tapping applies and saves it (public/theme.js); the scheme
// follows the device.
function themeSwatch(t) {
  const half = (scheme) => {
    const s = (t.swatch && t.swatch[scheme]) || { bg: t.bg[scheme === 'dark' ? 1 : 0], card: '', accent: '' };
    return h('span', { class: 'sw-half sw-' + scheme, style: `--sw-bg:${s.bg};--sw-card:${s.card || s.bg};--sw-accent:${s.accent || 'currentColor'}` },
      h('span', { class: 'sw-card' }, h('span', { class: 'sw-line' }), h('span', { class: 'sw-dot' })));
  };
  return h('span', { class: 'swatch', 'aria-hidden': 'true' }, half('light'), half('dark'));
}
function appearanceSheet() {
  const t = window.dshTheme; if (!t) return;
  const hint = h('p', { class: 'set-foot' });
  const saveNote = h('div', { class: 'set-note-slot' });
  const cards = t.THEMES.map((x) => h('button', {
    type: 'button', class: 'theme-card', role: 'radio', 'data-theme-id': x.id, title: x.hint,
    onclick: () => pick(x.id),
  }, themeSwatch(x), h('span', { class: 'theme-meta' }, h('span', { class: 'theme-name' }, x.label), h('span', { class: 'theme-check', 'aria-hidden': 'true' }))));
  const paint = () => {
    const now = t.current();
    const cur = t.THEMES.find((x) => x.id === now) || t.THEMES[0];
    for (const c of cards) {
      const on = c.getAttribute('data-theme-id') === cur.id;
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    }
    hint.textContent = `${cur.label}: ${cur.hint.charAt(0).toLowerCase()}${cur.hint.slice(1)}.`;
    if (settingsVals.theme) settingsVals.theme.textContent = cur.label;
  };
  const pick = (id) => {
    const saved = t.set(id);
    // The theme applies either way; say so in place when this browser would not keep it.
    saveNote.replaceChildren(...(saved ? [] : [setError('Applied until this page reloads.', 'This browser refused to save the choice.')]));
    paint();
  };
  const grid = h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme' }, ...cards);
  // Arrow keys move the choice, as in any radio group.
  grid.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = t.THEMES.findIndex((x) => x.id === t.current());
    const next = t.THEMES[(i + step + t.THEMES.length) % t.THEMES.length];
    pick(next.id);
    const c = cards.find((n) => n.getAttribute('data-theme-id') === next.id);
    if (c) c.focus();
  });
  openSheet({ size: 'large', grouped: true }, h('h3', {}, 'Appearance'),
    h('section', { class: 'set-sec' }, h('h4', { class: 'set-head' }, 'Theme'), grid, hint, saveNote),
    h('p', { class: 'set-foot set-foot-alone' }, 'Each theme follows your device’s light or dark setting, so there is no separate switch here. The choice is saved on this device.'));
  paint();
}

// ---------- Viewport (iOS keyboard) ----------
// #app is as tall as the visible window (--vvh), so a Safari tab keeps the composer
// above the toolbar. With the keyboard open, iOS pans a shorter
// visual viewport over the page to reach the focused field, so #app follows that window
// (top and height) in both modes.
const isField = (el) => !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable
  || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|file|submit|reset|range|color)$/.test(el.type)));
function fitViewport() {
  const vv = window.visualViewport, root = document.documentElement;
  if (!root || !root.classList) return;
  // Large text: the user's iOS text size (or a browser zoom) leaves too little width for the
  // 44pt controls and a readable field on one row. Say so with a class, and let style.css put
  // the composer's field on its own row and let the nav title use what is left between the
  // bars' buttons instead of trying to centre in a space that is no longer there.
  let rootPx = 17;
  try { if (typeof getComputedStyle === 'function') rootPx = parseFloat(getComputedStyle(root).fontSize) || 17; } catch {}
  const widthPx = window.innerWidth || root.clientWidth || 390;
  root.classList.toggle('type-large', widthPx / rootPx < 18);
  const standalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  // Only a page drawn under the status bar (top inset > 0) has the iOS 26 shortfall;
  // with an opaque status bar the page starts below it and reaches the home indicator.
  if (!fitViewport.probe && document.body) {
    fitViewport.probe = document.createElement('div');
    fitViewport.probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none;';
    document.body.append(fitViewport.probe);
  }
  const underBar = !!fitViewport.probe && fitViewport.probe.offsetHeight > 0;
  const short = window.screen ? screen.height - window.innerHeight : 0;
  root.classList.toggle('ios-short', standalone && underBar && short >= 40 && short <= 80);
  const full = root.clientHeight;
  // Keyboard state comes from the viewport, not focus, so the layout holds until the
  // keyboard has actually gone. A pinch zoom also shrinks the visual viewport; skip it.
  const kb = !!vv && Math.abs((vv.scale || 1) - 1) < 0.01 && vv.height < full * 0.85;
  root.classList.toggle('kb', kb);
  // Typing into a card hides the feed (display: none drops its scroll position), so keep it.
  const card = kb && isField(document.activeElement) && !!document.activeElement.closest('#pending');
  const feed = document.getElementById('feed');
  if (feed && card && !root.classList.contains('kb-card')) fitViewport.feedTop = feed.scrollTop;
  root.classList.toggle('kb-card', card);
  if (feed && !card && fitViewport.feedTop != null) { feed.scrollTop = fitViewport.feedTop; fitViewport.feedTop = null; }
  if (!vv) root.style.setProperty('--vvh', window.innerHeight + 'px');
  else if (Math.abs((vv.scale || 1) - 1) < 0.01) root.style.setProperty('--vvh', vv.height + 'px');
  if (kb) {
    root.style.setProperty('--vvtop', vv.offsetTop + 'px');
    root.style.setProperty('--vvbot', Math.max(0, full - vv.offsetTop - vv.height) + 'px');
  }
}
function refit() {
  fitViewport();
  stick();
  // Typing into a question card: keep that field in sight inside the (now shorter) card list.
  const a = document.activeElement;
  if (document.documentElement?.classList?.contains('kb-card')) {
    a.scrollIntoView({ block: 'nearest' });
    $('#app').scrollTop = 0; // scrollIntoView also scrolls overflow:hidden ancestors; the frame must not move
  }
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', refit);
  visualViewport.addEventListener('scroll', fitViewport);
}
window.addEventListener('resize', fitViewport);
// The keyboard can open and close without a resize reaching us first (or at all, on a
// field-to-field hop), so re-check after focus moves and once the animation settles.
document.addEventListener('focusin', () => { refit(); setTimeout(refit, 350); });
document.addEventListener('focusout', () => setTimeout(refit, 50));
fitViewport();

// ---------- Boot ----------
(async function boot() {
  linkTargets();
  window.addEventListener('load', linkTargets);
  linkClicks();
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
    if (e.code === 'http-404' || e.code === 'http-401') {
      // dsh 0.2 has no host.describe. Ask for something only it has before giving up.
      try {
        await post('session/canOpenWorkspacePath', { args: {} });
        if (!window.dsh02) return toast('public/dsh02.js did not load, so this page cannot talk to dsh 0.2', 8000);
        S.describe = null; startDsh2();
      } catch (e2) {
        if (e2.code === 'login') return;
        return showUnsupportedDsh(e.code);
      }
    } else toast('dsh not reachable: ' + e.message, 6000);
  }
  loadTunnelUrl().then((url) => {
    S.tunnelUrl = url;
    // The Settings page can be open before this local read finishes; add This device in place.
    if (url && sheetOpen() && sheetCur.title === 'Settings') settingsSheet();
  });
  connect();
  await loadSessions();
  if (location.hash) route();
})();
