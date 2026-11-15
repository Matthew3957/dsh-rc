import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as review from '../public/review.js';

// Motion, announcements and polish (docs/design/2026-11-14-redesign.md, PR 7). These run the
// real public/app.js in a vm over a small DOM stub, the same approach as shell.test.mjs. Timers
// run only when a test says so. `animate` gives the stub elements a fake Web Animations API, so
// the paths that move things can be checked without a browser; without it every change is
// instant, which is what the rest of the suite sees.

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const CSS = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// Values made inside the vm have its own Array and Object, so compare them as plain data.
const plain = (o) => JSON.parse(JSON.stringify(o));

function fakeAnimation(el, frames, opts) {
  const a = { el, frames, opts, cancelled: false, onfinish: null, cancel() { a.cancelled = true; }, finish() { if (a.onfinish) a.onfinish(); } };
  return a;
}

function stubEl(selector, tag, { animate, anims }) {
  let text = null;
  const props = {};
  const el = {
    nodeType: 1, selector, tagName: tag, hidden: false, value: '', className: '', childNodes: [], dataset: {},
    style: { setProperty(k, v) { props[k] = String(v); }, removeProperty(k) { delete props[k]; }, getPropertyValue: (k) => props[k] || '', props },
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0,
    get textContent() { return text != null ? text : el.childNodes.map((n) => (typeof n === 'string' ? n : n.textContent)).join(''); },
    set textContent(v) { text = String(v); el.childNodes = []; },
    classList: {
      add: (...cs) => { for (const c of cs) if (!el.classList.contains(c)) el.className = (el.className + ' ' + c).trim(); },
      remove: (...cs) => { el.className = el.className.split(/\s+/).filter((x) => x && !cs.includes(x)).join(' '); },
      toggle: (c, on) => { (on ?? !el.classList.contains(c)) ? el.classList.add(c) : el.classList.remove(c); },
      contains: (c) => el.className.split(/\s+/).includes(c),
    },
    listeners: {},
    addEventListener(name, fn) { (el.listeners[name] ||= []).push(fn); },
    removeEventListener() {},
    setAttribute(name, value) { el[name] = String(value); },
    getAttribute: (name) => (el[name] === undefined ? null : el[name]),
    removeAttribute(name) { delete el[name]; },
    append(...kids) { el.childNodes.push(...kids); },
    appendChild(kid) { el.childNodes.push(kid); return kid; },
    prepend(...kids) { el.childNodes.unshift(...kids); },
    replaceChildren(...kids) { text = null; el.childNodes = kids; },
    replaceWith() {}, remove() {},
    getClientRects: () => [{}],
    disabled: false,
    focus() {},
    click() { for (const fn of el.listeners.click || []) fn({ currentTarget: el, target: el, preventDefault() {} }); },
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext: () => ({}),
  };
  if (animate) el.animate = (frames, opts) => { const a = fakeAnimation(el, frames, opts); anims.push(a); return a; };
  return el;
}

function harness({ animate = false, reduce = false } = {}) {
  const anims = [];
  const els = new Map();
  const mk = (sel, tag) => stubEl(sel, tag, { animate, anims });
  const at = (sel, init = {}) => { const el = Object.assign(mk(sel), init); els.set(sel, el); return el; };
  // The page as it loads: the board shown, the chat and the sheet hidden.
  for (const sel of ['#sheet', '#scrim', '#sheetBack', '#sheetFoot', '#chatView', '#toast']) at(sel, { hidden: true });
  const docListeners = {};
  const document = {
    visibilityState: 'visible',
    documentElement: { style: { setProperty() {} } },
    body: mk('body', 'BODY'),
    activeElement: undefined,
    addEventListener(name, fn) { (docListeners[name] ||= []).push(fn); },
    createElement: (tag) => mk('<' + tag + '>', tag.toUpperCase()),
    querySelector(sel) { return els.get(sel) || at(sel); },
    querySelectorAll: () => [],
  };
  const media = (q) => ({ matches: reduce && /prefers-reduced-motion: reduce/.test(q) });
  const window = { addEventListener() {}, innerHeight: 800, matchMedia: media, scrollTo() {}, dshReview: review };
  const timers = [];
  const context = {
    window, document, navigator: {}, console,
    location: { hash: '', protocol: 'http:', host: 'localhost', pathname: '/' },
    history: { pushState() {} },
    WebSocket: function WebSocketStub() { return { close() {}, send() {}, readyState: 1 }; },
    requestAnimationFrame: (cb) => { cb(); return 0; }, cancelAnimationFrame() {},
    matchMedia: media,
    getComputedStyle: () => ({ transform: 'none', opacity: '1' }),
    crypto: { randomUUID: () => 'rpc' },
    fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  context.globalThis = context;
  vm.createContext(context);
  const epilogue = '\n;globalThis.__t = { S, R, onMux, setConn, rerender, applyLive, toast, segmented, showView, openSheet, closeSheet, sheetOpen, h, get stack() { return sheetStack.length; } };';
  vm.runInContext(APP + epilogue, context, { filename: 'public/app.js' });
  const t = context.__t;
  t.el = (sel) => document.querySelector(sel);
  t.anims = anims;
  t.timers = timers;
  // Run the queued timers, and any they queue, in order (with a cap, in case one reschedules itself).
  t.runTimers = (max = 200) => { for (let i = 0; timers.length && i < max; i++) timers.shift().fn(); };
  t.nextTimer = () => { const x = timers.shift(); if (x) x.fn(); return x; };
  t.key = (key) => { for (const fn of docListeners.keydown || []) fn({ key, shiftKey: false, preventDefault() {} }); };
  t.said = () => t.el('#announce').textContent.trim();
  return t;
}

// ---- wire shapes ----
let seq = 0;
const ev = (sessionId, type, data = {}, extra = {}) => ({ type: 'session/event', sessionId, event: { type, seq: seq++, time: 1_700_000_000_000 + seq * 1000, data }, ...extra });
const turnStart = (sid) => ev(sid, 'turn/start');
const turnEnd = (sid, reason) => ev(sid, 'turn/end', reason ? { reason } : {});
const bashCall = (sid, callId, command) => ev(sid, 'tool/call', { callId, name: 'bash', arguments: JSON.stringify({ command }) },
  { view: { view: { card: 'terminal', title: 'bash ' + command } } });
const bashResult = (sid, callId, exitCode) => ev(sid, 'tool/result',
  { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'ok' }] }] } },
  { view: { view: { card: 'terminal', exitCode } } });

// The page is past the burst of decisions that arrive with the first connection.
function live(t) { t.setConn(true); t.runTimers(); }
function openChat(t, id) {
  seq = 0;
  t.S.cur = { id, events: [], lastSeq: -1, loading: false, buffer: [], hasMore: false, gen: 0 };
  t.R.reset();
}

test('index.html has one polite, visually hidden region for announcements', () => {
  const tag = (HTML.match(/<div id="announce"[^>]*>/) || [''])[0];
  assert.match(tag, /class="vh"/);
  assert.match(tag, /aria-live="polite"/);
  assert.match(tag, /aria-atomic="true"/);
});

test('a live turn end in the open session is announced with the receipt verdict and counts', () => {
  const t = harness();
  live(t);
  openChat(t, 's1');
  for (const f of [turnStart('s1'), bashCall('s1', 'c1', 'npm test'), bashResult('s1', 'c1', 0), turnEnd('s1', { kind: 'completed' })]) t.onMux(f, {});
  assert.equal(t.said(), 'Turn passed, 1 command');

  // A command that exited non-zero fails the turn on the receipt, so it is announced failed too.
  for (const f of [turnStart('s1'), bashCall('s1', 'c2', 'npm run lint'), bashResult('s1', 'c2', 1), turnEnd('s1', { kind: 'completed' })]) t.onMux(f, {});
  assert.equal(t.said(), 'Turn failed, 1 command');

  for (const f of [turnStart('s1'), turnEnd('s1', { kind: 'aborted' })]) t.onMux(f, {});
  assert.equal(t.said(), 'Turn stopped');
});

test('the same words twice in a row are still announced, and the region clears itself later', () => {
  const t = harness();
  live(t);
  openChat(t, 's1');
  t.onMux(turnStart('s1'), {}); t.onMux(turnEnd('s1', { kind: 'completed' }), {});
  const first = t.el('#announce').textContent;
  t.onMux(turnStart('s1'), {}); t.onMux(turnEnd('s1', { kind: 'completed' }), {});
  const second = t.el('#announce').textContent;
  assert.equal(first.trim(), 'Turn passed');
  assert.notEqual(first, second, 'a repeat changes the region so a screen reader reads it again');
  t.runTimers();
  assert.equal(t.el('#announce').textContent, '');
});

test('a turn end buffered while history loads is announced once, after its receipt is painted', () => {
  const t = harness();
  live(t);
  openChat(t, 's1');
  const frames = [turnStart('s1'), bashCall('s1', 'c1', 'npm test'), bashResult('s1', 'c1', 0)];
  const end = turnEnd('s1', { kind: 'completed' });
  frames.push(end);
  t.S.cur.loading = true;
  for (const f of frames) t.onMux(f, {});
  assert.equal(t.said(), '', 'nothing is announced while the frames wait for history');
  const buf = t.S.cur.buffer; t.S.cur.buffer = []; t.S.cur.loading = false;
  for (const f of buf) t.applyLive(f);
  assert.equal(t.said(), 'Turn passed, 1 command', 'the receipt is painted before it is read');
  t.onMux(end, {});
  assert.equal(t.said(), 'Turn passed, 1 command', 'a replayed frame with the same seq says nothing new');
});

test('history replay announces nothing, and neither does a subagent or another session under an open chat', () => {
  const t = harness();
  live(t);
  openChat(t, 's1');
  t.S.cur.events = [turnStart('s1'), bashCall('s1', 'c1', 'npm test'), bashResult('s1', 'c1', 0), turnEnd('s1', { kind: 'completed' })];
  t.rerender(false);
  assert.equal(t.said(), '', 'a replayed turn/end is history, not news');

  t.S.parent.set('sub-1', 's1');
  t.onMux(turnEnd('sub-1', { kind: 'completed' }), {});
  assert.equal(t.said(), '', 'a subagent turn is part of its parent turn');

  t.onMux(turnEnd('s2', { kind: 'error' }), {});
  assert.equal(t.said(), '', 'another session does not talk over the open conversation');
});

test('on the board a session that finishes is announced by name', () => {
  const t = harness();
  live(t);
  t.S.titles.set('s2', 'Draft the release notes');
  t.onMux(turnEnd('s2', { kind: 'error', error: { message: 'boom' } }), {});
  assert.equal(t.said(), 'Draft the release notes: turn failed');
});

test('on the board a completed turn is not called passed, since its commands are not known there', () => {
  const t = harness();
  live(t);
  t.S.titles.set('s2', 'Draft the release notes');
  t.onMux(turnEnd('s2', { kind: 'completed' }), {});
  assert.equal(t.said(), 'Draft the release notes: turn finished');
});

test('a newly arrived approval or question is announced once; one waiting at load or re-sent on reconnect is not', () => {
  const t = harness();
  t.S.titles.set('s2', 'Fix the off-by-one');
  const approval = (id, command) => ({ type: 'approval/requested', approvalId: id, sessionId: 's2', toolName: 'bash', args: JSON.stringify({ command }) });
  // The burst that comes with the first connection: already on screen, so not news.
  t.onMux(approval('a1', 'ls'), { rpcId: 'r1' });
  t.setConn(true);
  t.onMux(approval('a1', 'ls'), { rpcId: 'r1' });
  assert.equal(t.said(), '');
  t.runTimers();

  t.onMux(approval('a1', 'ls'), { rpcId: 'r1' });
  assert.equal(t.said(), '', 'a reconnect re-sends what is waiting; it is not new');

  t.onMux(approval('a2', 'npm run build && npm test'), { rpcId: 'r2' });
  assert.equal(t.said(), 'Approval needed for Bash in Fix the off-by-one: npm run build && npm test');

  t.onMux({ type: 'question/requested', sessionId: 's2', questions: [{ id: 'q', question: 'Which branch should I use?\nThere are two.' }] }, { rpcId: 'r3' });
  assert.equal(t.said(), 'Question in Fix the off-by-one: Which branch should I use?');
  t.onMux({ type: 'question/requested', sessionId: 's2', questions: [{ id: 'q', question: 'Which branch should I use?' }] }, { rpcId: 'r3' });
  assert.equal(t.said(), 'Question in Fix the off-by-one: Which branch should I use?', 'the same request again says nothing new');

  // In the session it belongs to, the card is right there: no need to name the session.
  openChat(t, 's2');
  t.onMux(approval('a3', 'git push'), { rpcId: 'r4' });
  assert.equal(t.said(), 'Approval needed for Bash: git push');
});

test('the toast fades out before it is hidden, and a new one replaces it at once', () => {
  const t = harness();
  t.toast('Copied');
  const el = t.el('#toast');
  assert.equal(el.hidden, false);
  t.nextTimer(); // its time is up
  assert.ok(el.classList.contains('out'), 'leaving');
  assert.equal(el.hidden, false, 'still drawn while it fades');
  t.toast('Archived');
  assert.equal(el.classList.contains('out'), false, 'a new toast stops the old one leaving');
  assert.equal(el.textContent, 'Archived');
  t.runTimers();
  assert.equal(el.hidden, true);
  assert.match(CSS, /#toast\.out \{ animation: fade-out 160ms/);
  assert.match(CSS, /@keyframes toast-in \{ from \{ opacity: 0; transform: translateY\(8px\); \} \}/);
});

test('the segmented thumb is told how many options there are and which one it sits under', () => {
  const t = harness();
  const seg = t.segmented([{ value: 'queue', label: 'Queue' }, { value: 'steer', label: 'Steer' }], 'queue', () => {}, 'When to send');
  assert.equal(seg.style.props['--seg-n'], '2');
  assert.equal(seg.style.props['--seg-i'], '0');
  const [q, s] = seg.childNodes;
  assert.equal(q.getAttribute('data-label'), 'Queue', 'each label reserves its semibold width');
  s.click();
  assert.equal(seg.style.props['--seg-i'], '1');
  assert.match(CSS, /\.seg::before \{[^}]*transform: translateX\(calc\(var\(--seg-i, 0\) \* \(100% \+ 2px\)\)\);[^}]*transition: transform var\(--dur-base\)/);
});

test('a closing sheet is closed at once for everything that asks, and slides away before it hides', () => {
  const t = harness({ animate: true });
  const { h } = t;
  t.openSheet(h('h3', {}, 'Settings'), 'rows');
  assert.equal(t.sheetOpen(), true);
  t.closeSheet();
  assert.equal(t.sheetOpen(), false, 'logically closed straight away');
  assert.equal(t.stack, 0);
  assert.equal(t.el('#listView').inert, false, 'the view behind is usable at once');
  assert.equal(t.el('#sheet').hidden, false, 'still drawn while it leaves');
  assert.equal(t.el('#sheet').inert, true, 'nothing in a leaving sheet can be pressed');
  const out = t.anims.find((a) => a.el === t.el('#sheet'));
  assert.deepEqual(plain(out.frames.map((f) => f.transform)), ['translateY(0px)', 'translateY(100%)']);
  assert.equal(out.opts.duration, 220);
  t.key('Escape'); // ignored: it is already closing
  out.finish();
  assert.equal(t.el('#sheet').hidden, true);
  assert.equal(t.el('#scrim').hidden, true);
  assert.equal(t.el('#sheet').inert, false);
});

test('a sheet asked to open while it is leaving opens fresh, with no stale back stack', () => {
  const t = harness({ animate: true });
  const { h } = t;
  t.openSheet(h('h3', {}, 'Settings'), 'rows');
  t.openSheet(h('h3', {}, 'Appearance'), 'themes');
  assert.equal(t.stack, 1);
  t.closeSheet();
  const out = t.anims.find((a) => a.el === t.el('#sheet') && /100%/.test(String(a.frames[1].transform)));
  t.openSheet(h('h3', {}, 'Session'), 'menu');
  assert.ok(out.cancelled, 'the exit stops');
  assert.equal(t.sheetOpen(), true);
  assert.equal(t.el('#sheet').hidden, false);
  assert.equal(t.stack, 0);
  assert.equal(t.el('#sheetBack').hidden, true);
});

test('under Reduce Motion the sheet fades out instead of sliding', () => {
  const t = harness({ animate: true, reduce: true });
  t.openSheet(t.h('h3', {}, 'Menu'), 'rows');
  t.closeSheet();
  const out = t.anims.find((a) => a.el === t.el('#sheet'));
  assert.deepEqual(plain(out.frames.map((f) => f.opacity)), [1, 0]);
  assert.equal(out.frames[0].transform, out.frames[1].transform, 'no travel');
  assert.equal(out.opts.duration, 120);
});

test('a view push flips [hidden] at once, slides the session in, and a second move settles the first', () => {
  const t = harness({ animate: true });
  const list = t.el('#listView'), chat = t.el('#chatView'), app = t.el('#app');
  t.showView(chat, list, 'push');
  assert.equal(list.hidden, true, 'the route and the tests see the new view straight away');
  assert.equal(chat.hidden, false);
  assert.ok(app.classList.contains('vt'));
  assert.ok(list.classList.contains('vt-leaving'), 'the board stays drawn until the move ends');
  const inn = t.anims.find((a) => a.el === chat), outv = t.anims.find((a) => a.el === list);
  assert.equal(inn.frames[0].transform, 'translateX(100%)');
  assert.equal(outv.frames[1].transform, 'translateX(-24%)');
  assert.equal(inn.opts.duration, 300);

  t.showView(list, chat, 'pop'); // Back, before the push has finished
  assert.ok(inn.cancelled && outv.cancelled, 'the push settled at once');
  assert.equal(list.hidden, false);
  assert.equal(chat.hidden, true);
  const back = t.anims.filter((a) => a.el === chat).at(-1);
  assert.deepEqual(plain(back.frames.map((f) => f.transform)), ['translateX(0)', 'translateX(100%)']);
  assert.equal(back.opts.duration, 260);
  back.finish();
  assert.equal(app.classList.contains('vt'), false);
  assert.equal(chat.classList.contains('vt-leaving'), false);

  t.showView(chat, list, 'fade');
  const fade = t.anims.filter((a) => a.el === chat).at(-1);
  assert.deepEqual(plain(fade.frames), [{ opacity: 0 }, { opacity: 1 }], 'direction unknown: a crossfade');
  assert.equal(fade.opts.duration, 150);
});

test('under Reduce Motion a view change is a 120ms fade', () => {
  const t = harness({ animate: true, reduce: true });
  t.showView(t.el('#chatView'), t.el('#listView'), 'push');
  for (const a of t.anims) {
    assert.ok(a.frames.every((f) => f.transform === undefined), 'nothing travels');
    assert.equal(a.opts.duration, 120);
  }
});

test('the stylesheet keeps one looping animation and a Reduce Motion block', () => {
  const loops = CSS.match(/animation:[^;]*infinite/g) || [];
  assert.deepEqual(loops, ['animation: spin .9s linear infinite'], 'only the working glyph loops');
  assert.doesNotMatch(CSS, /@keyframes pulse/);
  const rm = CSS.slice(CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(rm, /--dur-base: 120ms; --dur-slow: 120ms;/);
  assert.match(rm, /\.cbtn:active \.cbtn-ink \{ transform: none; \}/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{ \.glyph\.run::before \{ animation-duration: 3s; \} \}/);
  // Hover only where a pointer can hover, so a tap never leaves a sticky highlight.
  for (const m of CSS.matchAll(/^[^\n]*:hover[^\n]*$/gm)) assert.match(m[0], /@media \(hover: hover\)/, m[0]);
});
