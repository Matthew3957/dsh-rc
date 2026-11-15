import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The app shell (docs/design/2026-11-14-redesign.md, PR 2): the bars, the sheet with its back
// stack, the offline banner and the universal status glyph. The markup checks read
// public/index.html; the behaviour checks run the real public/app.js in a vm over a small DOM
// stub, the same approach as running.test.mjs.

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// ---- markup ----
const tagWithId = (id) => (HTML.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`)) || [null])[0];

test('index.html keeps every id the scripts and tests query', () => {
  const ids = ['app', 'listView', 'chatView', 'listScroll', 'pendingGlobal', 'api403', 'running', 'runningHead',
    'runningCount', 'runningCards', 'sessions', 'moreBtn', 'listDock', 'dockActions', 'searchBtn', 'newBtn',
    'searchRow', 'q', 'searchClose', 'menuListBtn', 'filterBtn', 'backBtn', 'title', 'subtitle', 'menuBtn',
    'statusBar', 'statusLine', 'statusSummary', 'statusCaret', 'statusBreakdown', 'goalBar', 'feed', 'olderBtn',
    'msgs', 'working', 'workingText', 'jumpBtn', 'dock', 'pending', 'queueLine', 'cmdpop', 'attachments',
    'composer', 'attachBtn', 'fileInput', 'tmplBtn', 'input', 'micBtn', 'steerBtn', 'sendBtn', 'stopBtn',
    'scrim', 'sheet', 'sheetBody', 'sheetClose', 'toast'];
  for (const id of ids) assert.ok(tagWithId(id), `#${id}`);
});

test('the sheet is a labelled modal dialog with a back button, Done and a footer, and no X', () => {
  const sheet = tagWithId('sheet');
  assert.match(sheet, /role="dialog"/);
  assert.match(sheet, /aria-modal="true"/);
  assert.match(sheet, /aria-labelledby="sheetTitle"/);
  assert.ok(tagWithId('sheetTitle') && tagWithId('sheetBack') && tagWithId('sheetFoot'));
  assert.match(HTML, /id="sheetClose"[^>]*>Done</);
  assert.doesNotMatch(HTML, />✕</, 'the grabber and the title row do the work; no redundant X');
});

test('both views have a nav bar with leading and trailing slots, and the list a bottom bar', () => {
  assert.equal((HTML.match(/<header class="nav"/g) || []).length, 2);
  assert.equal((HTML.match(/class="nav-lead"/g) || []).length, 3, 'list, chat and sheet title rows');
  assert.equal((HTML.match(/class="nav-trail"/g) || []).length, 3);
  assert.match(tagWithId('listDock'), /class="bottombar"/);
  // The connection dot is gone; losing the socket is a banner under each bar instead.
  assert.doesNotMatch(HTML, /class="conn dot"|round-btn|listdock/);
  assert.equal((HTML.match(/class="banner offline conn-banner" role="status"/g) || []).length, 2);
});

test('every icon-only bar button has an accessible name', () => {
  for (const id of ['menuListBtn', 'filterBtn', 'searchBtn', 'backBtn', 'menuBtn', 'sheetBack']) {
    assert.match(tagWithId(id), /aria-label="[^"]+"/, `#${id}`);
  }
});

// ---- behaviour ----
function stubEl(selector, tag) {
  let text = null;
  const el = {
    nodeType: 1, selector, tagName: tag, hidden: false, value: '', className: '', childNodes: [], dataset: {},
    style: { setProperty() {}, removeProperty() {} }, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    get textContent() { return text != null ? text : el.childNodes.map((n) => (typeof n === 'string' ? n : n.textContent)).join(''); },
    set textContent(v) { text = String(v); el.childNodes = []; },
    classList: {
      add: (c) => { if (!el.classList.contains(c)) el.className = (el.className + ' ' + c).trim(); },
      remove: (c) => { el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
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
    replaceChildren(...kids) { text = null; el.childNodes = kids; },
    replaceWith() {}, remove() {},
    getClientRects: () => [{}],
    disabled: false,
    focus() { focused.push(el); },
    click() { for (const fn of el.listeners.click || []) fn({ currentTarget: el }); },
    matches: (sel) => sel === 'input, textarea, select' && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''),
    querySelector(sel) {
      if (sel !== 'input, textarea, select') return null;
      const walk = (n) => (n && n.nodeType === 1 ? (n.matches(sel) ? n : n.childNodes.map(walk).find(Boolean)) : null);
      return el.childNodes.map(walk).find(Boolean) || null;
    },
    querySelectorAll: () => [],
    getContext: () => ({}),
  };
  return el;
}
let focused = [];

function harness() {
  focused = [];
  const els = new Map();
  const at = (sel, init = {}) => { const el = Object.assign(stubEl(sel), init); els.set(sel, el); return el; };
  for (const sel of ['#sheet', '#scrim', '#sheetBack', '#sheetFoot']) at(sel, { hidden: true });
  const banners = [stubEl('.conn-banner'), stubEl('.conn-banner')].map((b) => Object.assign(b, { hidden: true, className: 'banner offline conn-banner' }));
  const docListeners = {};
  const document = {
    visibilityState: 'visible',
    documentElement: { style: { setProperty() {} } },
    body: stubEl('body', 'BODY'),
    activeElement: undefined,
    addEventListener(name, fn) { (docListeners[name] ||= []).push(fn); },
    createElement: (tag) => stubEl('<' + tag + '>', tag.toUpperCase()),
    querySelector(sel) { return els.get(sel) || at(sel); },
    querySelectorAll: (sel) => (sel === '.conn-banner' ? banners : []),
  };
  const window = { addEventListener() {}, innerHeight: 800, matchMedia: () => ({ matches: false }), scrollTo() {} };
  const timers = [];
  const context = {
    window, document, navigator: {}, console,
    location: { hash: '', protocol: 'http:', host: 'localhost', pathname: '/' },
    history: { pushState() {} },
    WebSocket: function WebSocketStub() { return { close() {}, send() {}, readyState: 1 }; },
    requestAnimationFrame: (cb) => { cb(); return 0; }, cancelAnimationFrame() {},
    matchMedia: window.matchMedia,
    crypto: { randomUUID: () => 'rpc' },
    fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }),
    // Timers the shell starts (the banner fade) run when the test says so.
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  context.globalThis = context;
  vm.createContext(context);
  const epilogue = '\n;globalThis.__t = { openSheet, closeSheet, sheetBack, segmented, setConn, statusGlyph, glyphEl, h, get stack() { return sheetStack.length; } };';
  vm.runInContext(APP + epilogue, context, { filename: 'public/app.js' });
  const t = context.__t;
  t.el = (sel) => document.querySelector(sel);
  t.document = document;
  t.banners = banners;
  t.runTimers = () => { while (timers.length) timers.shift().fn(); };
  t.key = (key, shiftKey = false) => { for (const fn of docListeners.keydown || []) fn({ key, shiftKey, preventDefault() {} }); };
  return t;
}
const title = (t) => t.el('#sheetTitle').textContent;
const bodyText = (t) => t.el('#sheetBody').textContent;

test('a sheet takes its title from its heading, and a second title pushes with a way back', () => {
  const t = harness();
  const { h } = t;
  t.openSheet(h('h3', {}, 'Menu'), h('button', { class: 'menuitem' }, 'Theme'));
  assert.equal(t.el('#sheet').hidden, false);
  assert.equal(t.el('#scrim').hidden, false);
  assert.equal(title(t), 'Menu');
  assert.equal(bodyText(t), 'Theme', 'the heading moved to the title row, not left in the body');
  assert.equal(t.el('#sheetBack').hidden, true, 'no back on the first sheet');
  assert.equal(t.el('#listView').inert, true, 'the view behind is inert while the sheet is open');

  t.openSheet(h('h3', {}, 'Theme'), h('button', { class: 'menuitem' }, 'Winter'));
  assert.equal(title(t), 'Theme');
  assert.equal(t.el('#sheetBack').hidden, false);
  t.openSheet(h('h3', {}, 'Theme'), h('button', { class: 'menuitem' }, 'Spring'));
  assert.equal(t.stack, 1, 'the same title redraws in place');
  assert.equal(bodyText(t), 'Spring');

  t.el('#sheetBack').click();
  assert.equal(title(t), 'Menu');
  assert.equal(bodyText(t), 'Theme', 'back restores the sheet below as it was');
  assert.equal(t.el('#sheetBack').hidden, true);
});

test('opening a title already in the stack goes back to it instead of growing the stack', () => {
  const t = harness();
  const { h } = t;
  t.openSheet(h('h3', {}, 'Scheduled prompts'), 'list');
  t.openSheet(h('h3', {}, 'Water the plants'), 'detail');
  t.openSheet(h('h3', {}, 'Edit scheduled prompt'), 'form');
  assert.equal(t.stack, 2);
  t.openSheet(h('h3', {}, 'Scheduled prompts'), 'list again');
  assert.equal(t.stack, 0);
  assert.equal(t.el('#sheetBack').hidden, true);
});

test('a primary action moves to the footer, the way out becomes Cancel, and a field makes it large', () => {
  const t = harness();
  const { h } = t;
  t.openSheet(h('h3', {}, 'Menu'), h('button', { class: 'menuitem' }, 'Rename'));
  assert.equal(t.el('#sheetClose').textContent, 'Done');
  assert.equal(t.el('#sheet').getAttribute('data-size'), 'medium');
  assert.equal(t.el('#sheetFoot').hidden, true);
  const go = h('button', { type: 'button', class: 'go' }, 'Save');
  const cancel = h('button', { type: 'button', class: 'menuitem' }, 'Cancel');
  t.openSheet(h('h3', {}, 'Rename'), h('input', { type: 'text' }), go, cancel);
  assert.equal(t.el('#sheetFoot').hidden, false);
  assert.deepEqual(t.el('#sheetFoot').childNodes, [go, cancel]);
  assert.equal(t.el('#sheetClose').textContent, 'Cancel');
  assert.equal(t.el('#sheet').getAttribute('data-size'), 'large');
  t.sheetBack();
  assert.equal(t.el('#sheetFoot').hidden, true, 'the sheet below gets its own (empty) footer back');
  assert.equal(t.el('#sheetClose').textContent, 'Done');
});

test('Escape and the scrim close the sheet, clear the stack and hand focus back to the opener', () => {
  const t = harness();
  const { h } = t;
  const opener = Object.assign(t.h('button', {}, 'Menu'), { isConnected: true });
  t.document.activeElement = opener;
  t.openSheet(h('h3', {}, 'Menu'), 'rows');
  t.openSheet(h('h3', {}, 'Theme'), 'themes');
  assert.ok(focused.includes(t.el('#sheet')), 'focus moves into the sheet');
  t.document.activeElement = t.document.body; // the focused row went away with the redraw
  t.key('Escape');
  assert.equal(t.el('#sheet').hidden, true);
  assert.equal(t.el('#scrim').hidden, true);
  assert.equal(t.stack, 0);
  assert.equal(t.el('#listView').inert, false);
  assert.equal(focused.at(-1), opener, 'focus returns to what opened the sheet');

  t.openSheet(h('h3', {}, 'Menu'), 'rows');
  for (const fn of t.el('#scrim').listeners.click) fn();
  assert.equal(t.el('#sheet').hidden, true, 'a scrim tap closes it too');
});

test('focus is handed back to a text field trigger as well', () => {
  const t = harness();
  const field = Object.assign(t.h('textarea', {}), { isConnected: true });
  t.document.activeElement = field;
  t.openSheet(t.h('h3', {}, 'Prompt templates'), 'rows');
  focused = [];
  t.document.activeElement = t.document.body;
  t.closeSheet();
  assert.equal(focused.at(-1), field, 'a sheet is a detour, so the editor gets focus back');
});

test('Tab and Shift+Tab wrap inside the sheet and cannot leave it', () => {
  const t = harness();
  const { h } = t;
  const first = h('button', {}, 'First');
  const last = h('button', {}, 'Last');
  const sheet = t.el('#sheet');
  sheet.contains = (n) => n === sheet || n === first || n === last;
  sheet.querySelectorAll = () => [first, last];
  t.openSheet(h('h3', {}, 'Menu'), 'rows');
  t.document.activeElement = last;
  t.key('Tab');
  assert.equal(focused.at(-1), first, 'Tab from the last control wraps to the first');
  t.document.activeElement = first;
  t.key('Tab', true);
  assert.equal(focused.at(-1), last, 'Shift+Tab from the first control wraps to the last');
  t.document.activeElement = t.document.body;
  t.key('Tab');
  assert.equal(focused.at(-1), first, 'focus outside the sheet is pulled back to the first control');
});

test('losing the socket shows the offline banner; reconnecting fades it out without a toast', () => {
  const t = harness();
  const toastBefore = t.el('#toast').textContent;
  t.setConn(false);
  assert.equal(t.el('#app').getAttribute('data-conn'), 'down');
  for (const b of t.banners) assert.equal(b.hidden, false);
  t.setConn(true);
  assert.equal(t.el('#app').getAttribute('data-conn'), 'up');
  for (const b of t.banners) assert.ok(b.classList.contains('out'), 'fading');
  t.runTimers();
  for (const b of t.banners) { assert.equal(b.hidden, true); assert.equal(b.classList.contains('out'), false); }
  assert.equal(t.el('#toast').textContent, toastBefore, 'no toast was raised for it');
});

test('a session state maps onto the one glyph vocabulary', () => {
  const t = harness();
  const state = (el) => el.className.replace(/^glyph /, '');
  assert.equal(state(t.glyphEl('wait approve')), 'approve');
  assert.equal(state(t.glyphEl('wait ask')), 'ask');
  assert.equal(state(t.glyphEl('run')), 'run');
  assert.equal(state(t.glyphEl('error')), 'failed');
  assert.equal(state(t.glyphEl('unread')), 'unread');
  assert.equal(state(t.glyphEl('idle')), 'idle');
  assert.equal(t.statusGlyph('done', 'bullet').className, 'glyph done bullet');
  assert.equal(t.statusGlyph('nonsense').className, 'glyph idle');
  assert.equal(t.statusGlyph('stopped').getAttribute('aria-hidden'), 'true');
});

test('the tool, job, subagent and plugin rows all draw the shared glyph', () => {
  for (const role of ['bullet', 'jdot', 'adot', 'run-dot', 'pdot']) {
    assert.match(APP, new RegExp(`statusGlyph\\([^\\n]*'${role}'\\)`), role);
  }
});

test('the segmented control is a radiogroup that moves by tap and by arrow key', () => {
  const t = harness();
  const picked = [];
  const seg = t.segmented([{ value: 'queue', label: 'Queue' }, { value: 'steer', label: 'Steer' }], 'queue', (v) => picked.push(v), 'When to send');
  assert.equal(seg.getAttribute('role'), 'radiogroup');
  assert.equal(seg.getAttribute('aria-label'), 'When to send');
  const [q, s] = seg.childNodes;
  assert.equal(q.getAttribute('aria-checked'), 'true');
  assert.equal(s.getAttribute('aria-checked'), 'false');
  s.click();
  assert.deepEqual(picked, ['steer']);
  assert.equal(s.getAttribute('aria-checked'), 'true');
  assert.equal(seg.segValue(), 'steer');
  for (const fn of s.listeners.keydown) fn({ key: 'ArrowRight', preventDefault() {} });
  assert.deepEqual(picked, ['steer', 'queue'], 'the arrow wraps round to the first');
  assert.equal(q.getAttribute('aria-checked'), 'true');
});
