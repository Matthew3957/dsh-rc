import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Settings and the session menu (docs/design/2026-11-14-redesign.md, section 4.7 and PR 6): one
// app-wide Settings, a session menu that only acts on the session, Appearance swatches, the
// notifications switch, Prices under Advanced, About and the QR actions. These run the real
// public/theme.js and public/app.js in a vm over a small DOM stub, as shell.test.mjs does.

const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const THEME = fs.readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const RP = JSON.parse(fs.readFileSync(new URL('../release-please-config.json', import.meta.url), 'utf8'));

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
    focus() {},
    click() { for (const fn of el.listeners.click || []) fn({ currentTarget: el }); },
    dispatch(name) { for (const fn of el.listeners[name] || []) fn({ currentTarget: el, target: el, preventDefault() {} }); },
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

function harness({ pathname = '/', storageThrows = false, push = null, tunnel = null, share = false } = {}) {
  const els = new Map();
  const at = (sel, init = {}) => { const el = Object.assign(stubEl(sel), init); els.set(sel, el); return el; };
  for (const sel of ['#sheet', '#scrim', '#sheetBack', '#sheetFoot']) at(sel, { hidden: true });
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (storageThrows && k === 'dsh-rc.theme') throw new Error('denied'); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const rootAttrs = new Map();
  const document = {
    visibilityState: 'visible',
    documentElement: {
      style: { setProperty() {} },
      setAttribute: (k, v) => rootAttrs.set(k, v), removeAttribute: (k) => rootAttrs.delete(k), getAttribute: (k) => rootAttrs.get(k) ?? null,
    },
    body: stubEl('body', 'BODY'),
    activeElement: undefined,
    addEventListener() {},
    createElement: (tag) => stubEl('<' + tag + '>', tag.toUpperCase()),
    querySelector(sel) { return els.get(sel) || at(sel); },
    querySelectorAll: () => [],
  };
  const window = { addEventListener() {}, innerHeight: 800, matchMedia: () => ({ matches: false }), scrollTo() {} };
  const navigator = { userAgent: 'test' };
  const calls = { permissionInGesture: null, subscribed: 0, tests: 0, shared: [] };
  let gesture = false;
  if (push) {
    // A browser with push: a service worker with no subscription yet, and a permission prompt
    // that answers `push.answer`.
    const Notification = { permission: 'default', requestPermission: async () => { calls.permissionInGesture = gesture; Notification.permission = push.answer; return push.answer; } };
    window.Notification = Notification; window.PushManager = function PushManager() {};
    navigator.serviceWorker = { ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }), register: async () => {}, addEventListener() {} };
    window.__Notification = Notification;
  }
  if (share) navigator.share = async (data) => { calls.shared.push(data); };
  const fetch = async (url) => {
    if (url === './tunnel' && tunnel) return { ok: true, status: 200, json: async () => ({ url: tunnel }) };
    if (url === './push/test') { calls.tests++; return { ok: false, status: 503, json: async () => ({}) }; }
    return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
  };
  const context = {
    window, document, navigator, console, localStorage, fetch,
    location: { hash: '', protocol: 'http:', host: 'localhost', pathname },
    history: { pushState() {} },
    WebSocket: function WebSocketStub() { return { close() {}, send() {}, readyState: 1 }; },
    requestAnimationFrame: (cb) => { cb(); return 0; }, cancelAnimationFrame() {},
    matchMedia: window.matchMedia,
    crypto: { randomUUID: () => 'rpc' },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  if (push) context.Notification = window.__Notification;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(THEME, context, { filename: 'public/theme.js' });
  const epilogue = '\n;globalThis.__t = { S, h, openSheet, closeSheet, sheetBack, settingsSheet, sessionMenuSheet, appearanceSheet, notificationsSheet, pricesSheet, tunnelSheet, APP_VERSION, get stack() { return sheetStack.length; } };';
  vm.runInContext(APP + epilogue, context, { filename: 'public/app.js' });
  const t = context.__t;
  t.el = (sel) => document.querySelector(sel);
  t.store = store;
  t.root = rootAttrs;
  t.window = window;
  t.calls = calls;
  t.inGesture = (fn) => { gesture = true; try { fn(); } finally { gesture = false; } };
  return t;
}
const tick = () => new Promise((r) => setImmediate(r));
const walk = (n, out = []) => { if (n && n.nodeType === 1) { out.push(n); for (const k of n.childNodes) walk(k, out); } return out; };
const body = (t) => ({ nodeType: 1, childNodes: t.el('#sheetBody').childNodes });
const byClass = (root, c) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(c));
const label = (row) => (byClass(row, 'set-label')[0] || row).textContent;
const rows = (t) => byClass(body(t), 'set-row');
const rowNamed = (t, name) => rows(t).find((r) => label(r) === name);
const title = (t) => t.el('#sheetTitle').textContent;

test('the gear opens one Settings: grouped rows, values, and no duplicated entries', async () => {
  const t = harness();
  t.el('#settingsBtn').onclick();
  assert.equal(title(t), 'Settings');
  assert.equal(t.el('#sheet').getAttribute('data-grouped'), '', 'a grouped sheet, the page colour behind card groups');
  assert.equal(t.el('#sheet').getAttribute('data-size'), 'large');
  assert.deepEqual(rows(t).map(label), ['Notifications', 'Appearance', 'Plugins & connectors', 'Prices', 'Version', 'Source code']);
  const heads = byClass(body(t), 'set-head').map((n) => n.textContent);
  assert.deepEqual(heads, ['dsh', 'Advanced', 'About'], 'This device is left out while no tunnel runs');
  // Rows carry a value, not a subtitle; explanations are in the group footers.
  assert.equal(walk(body(t)).filter((n) => n.tagName === 'SMALL').length, 0, 'no subtitle on any row');
  assert.ok(byClass(body(t), 'set-foot').length >= 4);
  assert.equal(label(rowNamed(t, 'Appearance')), 'Appearance');
  assert.match(rowNamed(t, 'Appearance').textContent, /Default/);
  assert.match(rowNamed(t, 'Prices').textContent, /Built-in|Unavailable/);
  await tick();
  assert.match(rowNamed(t, 'Notifications').textContent, /Not supported/, 'the stub browser has no push');
});

test('Settings > About: the version, the source link, and the full dsh UI only where it exists', () => {
  const t = harness();
  t.settingsSheet();
  assert.equal(rowNamed(t, 'Version').textContent, 'Version' + PKG.version);
  const src = rowNamed(t, 'Source code');
  assert.equal(src.tagName, 'A');
  assert.match(src.href, /^https:\/\/github\.com\/[^/]+\/dsh-rc$/);
  assert.equal(src.target, '_blank');
  assert.equal(src.rel, 'noopener');
  assert.equal(rowNamed(t, 'Open full dsh web UI'), undefined, 'dsh-rc on its own origin has no dsh UI at /');
  const mounted = harness({ pathname: '/m/' });
  mounted.settingsSheet();
  const full = rowNamed(mounted, 'Open full dsh web UI');
  assert.ok(full, 'mounted beside dsh, About links to it');
  assert.equal(full.href, '/');
});

test('the shown version is package.json’s, and the release bumps it with the package', () => {
  const t = harness();
  assert.equal(t.APP_VERSION, PKG.version);
  assert.match(APP, /const APP_VERSION = '[^']+'; \/\/ x-release-please-version/);
  const extra = RP.packages['.']['extra-files'] || [];
  assert.ok(extra.some((f) => (typeof f === 'string' ? f === 'public/app.js' : f.type === 'generic' && f.path === 'public/app.js')), 'release-please updates public/app.js');
});

test('the session menu acts on the session, then Settings, then Archive alone', () => {
  const t = harness();
  t.S.cur = { id: 'demo-session', events: [] };
  t.S.model.set('demo-session', { provider: 'deepseek-v41', model: 'deepseek-flash' });
  t.el('#title').textContent = 'Fix the off-by-one';
  t.el('#menuBtn').onclick();
  assert.equal(title(t), 'Fix the off-by-one');
  const names = rows(t).map(label);
  assert.deepEqual(names, ['Session details', 'Model', 'Rename', 'Fork', 'Export log', 'Settings', 'Archive']);
  assert.match(rowNamed(t, 'Model').textContent, /deepseek-flash/, 'the current model is the row value');
  for (const gone of ['Theme', 'Notifications', 'Plugins & connectors', 'Prices', 'Commands', 'Refresh', 'Open full dsh web UI']) {
    assert.ok(!names.includes(gone), `${gone} is not in the session menu`);
  }
  // Three groups: the session's actions, Settings, and Archive on its own in red.
  const groups = byClass(body(t), 'set-group');
  assert.equal(groups.length, 3);
  assert.deepEqual(byClass(groups[2], 'set-row').map(label), ['Archive']);
  assert.ok(byClass(groups[2], 'set-row')[0].className.includes('danger'));
  assert.deepEqual(byClass(groups[1], 'set-row').map(label), ['Settings']);
  // Settings pushes inside the same sheet, with Back to the menu.
  rowNamed(t, 'Settings').click();
  assert.equal(title(t), 'Settings');
  assert.equal(t.el('#sheetBack').hidden, false);
  t.sheetBack();
  assert.equal(title(t), 'Fix the off-by-one');
});

test('Archive still asks first and names what it does', () => {
  const t = harness();
  t.window.dshActions = { archiveSet: () => new Set(), visibleSessions: (s) => s };
  t.S.cur = { id: 'demo-session', events: [] };
  t.sessionMenuSheet();
  rowNamed(t, 'Archive').click();
  assert.equal(title(t), 'Archive this session?');
  assert.match(t.el('#sheetBody').textContent, /cannot be undone/);
  assert.match(t.el('#sheetFoot').textContent, /Archive session/);
});

test('every action the old menus had is at most two taps from where it belongs', () => {
  // App-wide ones: the gear, then the row.
  const t = harness();
  t.settingsSheet();
  for (const name of ['Notifications', 'Appearance', 'Plugins & connectors', 'Prices']) assert.ok(rowNamed(t, name), `gear > ${name}`);
  const tunnel = harness({ tunnel: 'https://demo.example.com' });
  tunnel.S.tunnelUrl = 'https://demo.example.com';
  tunnel.settingsSheet();
  assert.ok(rowNamed(tunnel, 'Open on your phone'), 'gear > Open on your phone, while a tunnel runs');
  // Commands is in the composer's plus menu; Refresh is in Session details.
  assert.match(APP, /item\('Commands', [^)]*then\(commandsSheet\)\)/);
  assert.match(APP, /\}, 'Refresh'\);/);
  assert.match(APP, /\$\('#sessionTitleButton'\)\.onclick = sessionDetailsSheet/);
});

test('Appearance: a swatch card per theme; a tap applies, saves and moves the ring and check', () => {
  const t = harness();
  t.settingsSheet();
  rowNamed(t, 'Appearance').click();
  assert.equal(title(t), 'Appearance');
  const cards = byClass(body(t), 'theme-card');
  assert.equal(cards.length, 7, 'seven themes, seven cards');
  assert.deepEqual(cards.map((c) => byClass(c, 'theme-name')[0].textContent),
    ['Default', 'Colourblind-safe', 'High contrast', 'Autumn', 'Winter', 'Spring', 'Mission Tile']);
  for (const c of cards) {
    const halves = byClass(c, 'sw-half');
    assert.equal(halves.length, 2, 'a light half and a dark half');
    for (const half of halves) assert.match(half.style, /--sw-bg:#[0-9a-f]{6};--sw-card:#[0-9a-f]{6};--sw-accent:#[0-9a-f]{6}/);
    assert.equal(byClass(c, 'theme-check').length, 1, 'the check is drawn, not only the ring');
  }
  const checked = () => cards.filter((c) => c.getAttribute('aria-checked') === 'true').map((c) => c.getAttribute('data-theme-id'));
  assert.deepEqual(checked(), ['default']);
  cards.find((c) => c.getAttribute('data-theme-id') === 'winter').click();
  assert.deepEqual(checked(), ['winter']);
  assert.equal(t.store.get('dsh-rc.theme'), 'winter', 'saved under the same key');
  assert.equal(t.root.get('data-theme'), 'winter', 'applied at once');
  assert.match(t.el('#sheetBody').textContent, /Winter: cool slate and ice\./, 'the chosen theme’s hint in the footer');
  assert.match(t.el('#sheetBody').textContent, /follows your device’s light or dark setting/);
  // Back to Settings shows the new value in place.
  t.sheetBack();
  assert.match(rowNamed(t, 'Appearance').textContent, /Winter/);
});

test('Appearance says so in place when the browser will not keep the choice', () => {
  const t = harness({ storageThrows: true });
  t.appearanceSheet();
  const card = byClass(body(t), 'theme-card').find((c) => c.getAttribute('data-theme-id') === 'contrast');
  card.click();
  assert.equal(t.root.get('data-theme'), 'contrast', 'still applied for this page');
  assert.equal(byClass(body(t), 'set-error').length, 1);
  assert.match(t.el('#sheetBody').textContent, /Applied until this page reloads/);
});

test('Notifications: a switch that asks inside the tap, and puts itself back when refused', async () => {
  const t = harness({ push: { answer: 'denied' } });
  await t.notificationsSheet();
  const sw = walk(body(t)).find((n) => n.id === 'pushSwitch');
  assert.ok(sw, 'the switch');
  assert.equal(sw.type, 'checkbox');
  assert.equal(sw.switch, '', 'the native switch attribute');
  assert.equal(sw.role, 'switch');
  assert.ok(sw.className.includes('switch-fb'), 'the styled fallback where the native switch is not drawn');
  assert.equal(sw.checked, false);
  assert.equal(sw.disabled, false);
  assert.match(t.el('#sheetBody').textContent, /Browser permissionNot asked yet/);
  assert.match(t.el('#sheetBody').textContent, /An approval is waiting\./, 'what sends a push');
  sw.checked = true;
  t.inGesture(() => sw.dispatch('change'));
  assert.equal(t.calls.permissionInGesture, true, 'the permission prompt is raised from the tap itself');
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sw.checked, false, 'refused, so the switch goes back to off');
  assert.equal(byClass(body(t), 'set-error').length, 1, 'and the sheet says why, in place');
  assert.match(t.el('#sheetBody').textContent, /did not allow notifications/);
  assert.match(t.el('#sheetBody').textContent, /Browser permissionBlocked/);
  assert.equal(sw.disabled, true, 'blocked: only the browser’s settings can change it now');
});

test('Notifications: Send a test is a real button, so keyboards reach it and it can be disabled', async () => {
  const t = harness();
  await t.notificationsSheet();
  const row = rowNamed(t, 'Send a test');
  assert.ok(row, 'the test row');
  assert.equal(String(row.tagName).toUpperCase(), 'BUTTON');
});

test('Notifications without push support: no switch to flip, and the reason', async () => {
  const t = harness();
  await t.notificationsSheet();
  const sw = walk(body(t)).find((n) => n.id === 'pushSwitch');
  assert.equal(sw.disabled, true);
  assert.match(t.el('#sheetBody').textContent, /does not support push notifications/);
});

test('Prices lives under Settings > Advanced and reports a bad table in place', () => {
  const t = harness();
  t.window.dshPrices = {
    loadPriceOverrides: () => ({}), savePriceOverrides: () => true,
    parsePriceOverrides: () => { throw new Error('not valid JSON'); },
  };
  t.settingsSheet();
  rowNamed(t, 'Prices').click();
  assert.equal(title(t), 'Prices');
  assert.equal(t.el('#sheetBack').hidden, false, 'a page of Settings, with Back');
  const box = walk(body(t)).find((n) => n.tagName === 'TEXTAREA');
  assert.ok(box && box.className.includes('prices-json'));
  const save = t.el('#sheetFoot').childNodes.find((n) => n.textContent === 'Save prices');
  assert.ok(save, 'Save is in the sticky footer');
  save.onclick();
  assert.equal(title(t), 'Prices', 'the sheet stays with what was typed');
  assert.match(t.el('#sheetBody').textContent, /not valid yet.*not valid JSON/);
});

test('the QR sheet keeps the address and adds Copy, and Share where the browser has it', async () => {
  const t = harness({ tunnel: 'https://demo.example.com', share: true });
  await t.tunnelSheet();
  assert.equal(title(t), 'Open on your phone');
  const text = t.el('#sheetBody').textContent;
  assert.match(text, /https:\/\/demo\.example\.com/);
  const acts = byClass(body(t), 'qr-acts')[0];
  assert.deepEqual(acts.childNodes.map((b) => b.textContent), ['Copy', 'Share']);
  acts.childNodes[1].onclick();
  assert.deepEqual(t.calls.shared.map((d) => d.url), ['https://demo.example.com']);
  const noShare = harness({ tunnel: 'https://demo.example.com' });
  await noShare.tunnelSheet();
  assert.deepEqual(byClass(body(noShare), 'qr-acts')[0].childNodes.map((b) => b.textContent), ['Copy']);
});
