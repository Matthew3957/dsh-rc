import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as prices from '../public/prices.js';

// app.js is a browser script: it reads the DOM at load time and drives everything
// through querySelector, fetch and the two event sockets. The harness below runs
// the real file in a vm context over a small DOM stub, so these tests exercise the
// shipped renderer rather than a copy of its arithmetic.
//
// PR 4 moved the old three-line status strip above the conversation into Session
// details. The header subtitle keeps only the folder and context percentage; the
// route, tokens, per-turn table and estimated cost live in the details sheet.

const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function stubEl(selector) {
  const el = {
    nodeType: 1,
    selector,
    hidden: false,
    open: false,
    value: '',
    textContent: '',
    className: '',
    childNodes: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
    classList: {
      add(c) { const s = new Set(String(el.className || '').split(/\s+/).filter(Boolean)); s.add(c); el.className = [...s].join(' '); },
      remove(c) { el.className = String(el.className || '').split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle(c, on) { const has = String(el.className || '').split(/\s+/).includes(c); (on === undefined ? !has : on) ? el.classList.add(c) : el.classList.remove(c); },
      contains: (c) => String(el.className || '').split(/\s+/).includes(c),
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(name, value) { el[name] = value; },
    getAttribute: (name) => el[name],
    removeAttribute() {},
    append(...kids) { el.childNodes.push(...kids); },
    appendChild(kid) { el.childNodes.push(kid); return kid; },
    replaceChildren(...kids) { el.childNodes = kids; },
    replaceWith() {},
    remove() {},
    focus() {},
    click() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    getClientRects: () => [],
    getContext: () => ({}),
    toBlob() {},
  };
  return el;
}

// Everything h() appends, flattened back to text.
function textOf(node) {
  if (typeof node === 'string') return node;
  if (node == null || typeof node === 'number') return node == null ? '' : String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.childNodes) return node.childNodes.map(textOf).join('');
  return '';
}

const elementKids = (el) => el.childNodes.filter((n) => n.nodeType === 1);
const byClass = (el, re) => elementKids(el).filter((n) => re.test(n.className || ''));
const find = (root, pred, out = []) => {
  if (!root || typeof root !== 'object') return out;
  if (root.nodeType === 1 && pred(root)) out.push(root);
  for (const k of root.childNodes || []) find(k, pred, out);
  return out;
};
// The details usage table is a grid of six cells per row: turn, the four token
// buckets and the estimate, with a header row first.
const tableRows = (box) => {
  const table = find(box, (n) => /status-table/.test(n.className || ''))[0];
  if (!table) return [];
  const cells = elementKids(table).map((n) => textOf(n).trim());
  const rows = [];
  for (let i = 0; i < cells.length; i += 6) rows.push(cells.slice(i, i + 6).join(' | '));
  return rows;
};
const notesOf = (box) => find(box, (n) => /status-note/.test(n.className || '')).map((n) => textOf(n).trim());

// Values cross the vm realm boundary, where deepEqual would trip on prototypes.
const plain = (o) => JSON.parse(JSON.stringify(o));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ respond } = {}) {
  const els = new Map();
  const document = {
    visibilityState: 'visible',
    documentElement: { style: { setProperty() {} } },
    addEventListener() {},
    createElement: (tag) => { const el = stubEl('<' + tag + '>'); el.tagName = tag.toUpperCase(); return el; },
    querySelector(sel) {
      if (!els.has(sel)) els.set(sel, stubEl(sel));
      return els.get(sel);
    },
    querySelectorAll: () => [],
  };
  const window = {
    dshPrices: prices,
    addEventListener() {},
    innerHeight: 800,
    matchMedia: () => ({ matches: false }),
    scrollTo() {},
  };
  const fetchCalls = [];
  const context = {
    window,
    document,
    navigator: {},
    location: { hash: '', protocol: 'http:', host: 'localhost', pathname: '/' },
    history: { pushState() {} },
    WebSocket: function WebSocketStub() { return { close() {}, send() {}, readyState: 1 }; },
    requestAnimationFrame: (cb) => { cb(); return 0; },
    cancelAnimationFrame() {},
    matchMedia: window.matchMedia,
    crypto: { randomUUID: () => 'rpc-' + fetchCalls.length },
    fetch: async (url, init) => {
      const method = String(url).replace(/^.*\/api\//, '');
      const payload = init && init.body ? JSON.parse(init.body) : {};
      fetchCalls.push({ method, payload });
      const value = respond ? respond(method, payload) : undefined;
      if (value === undefined) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ result: { ok: true, value } }) };
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  context.globalThis = context;
  vm.createContext(context);
  // The epilogue hands the tests the module-scope bindings (S and the renderers)
  // that a script would otherwise keep private.
  const epilogue = '\n;globalThis.__t = { S, renderStatusLine, renderSessionDetails, sessionDetailsSheet, turnUsage, openSession, onMux };';
  vm.runInContext(APP + epilogue, context, { filename: 'public/app.js' });
  const t = context.__t;
  t.el = (sel) => document.querySelector(sel);
  t.subtitle = () => document.querySelector('#subtitle').textContent;
  // The details renderer takes the box it fills; the page passes the sheet body,
  // and the tests make one directly so they do not need a real sheet.
  t.details = () => {
    const box = document.querySelector('#detailsContent');
    t.renderSessionDetails(box);
    return box;
  };
  return t;
}

// --- Real dsh shapes ---------------------------------------------------------
// contextPressure and tokenUsage are the wire views of dsh-token-meter's
// projections. tokenUsage names the buckets `uncachedInputTokens` and friends,
// while an event's usage sample reports the same figure as `inputTokens`.

const frame = (seq, type, data) => ({ event: { seq, time: 1_700_000_000_000 + seq, type, data } });
const usageFrame = (seq, turn, step, usage) => frame(seq, 'assistant/message', { turn, step, message: { content: [] }, usage });
// A session that has spent tokens has run a request, so its log carries the route
// dsh recorded for that request.
const routeEvent = (seq, provider, model) => frame(seq, 'request/context', { provider, model });

const PRESSURE = { pressureTokens: 58_800, projectedTokens: 61_234, contextWindow: 200_000 };
const SESSION_USAGE = { uncachedInputTokens: 1_200, outputTokens: 8_400, cacheReadTokens: 54_000, cacheWriteTokens: 9_000 };

function historyValue(events, { hasMore = false, projections = { contextPressure: PRESSURE, tokenUsage: SESSION_USAGE } } = {}) {
  return { events, hasMore, projections: { values: projections } };
}

// openSession asks session.models without awaiting it, so a test that wants the
// label from that call has to let the answer land.
const settle = () => tick();

function idleSession(t, id = 's1') {
  t.S.cur = { id, events: [], lastSeq: -1, loading: false, buffer: [], hasMore: false, gen: 0 };
  return id;
}

// --- Header subtitle ---------------------------------------------------------
// The one telemetry figure that stays on the glass, because it changes what to
// do next. Below 80% it is quiet folder + percentage; at 80% it becomes an
// explicit, tinted "Context N%" warning.

test('the header subtitle shows the folder and a quiet context percentage', () => {
  const t = harness();
  idleSession(t);
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  t.S.projections.set('s1', new Map([['contextPressure', { seq: 1, value: { projectedTokens: 61_234, contextWindow: 200_000 } }]]));
  t.renderStatusLine();
  assert.equal(t.subtitle(), 'notes-api · 31%');
  assert.equal(t.el('#subtitle').classList.contains('warn'), false);
});

test('the header turns the context into a tinted warning at 80% and a danger at 95%', () => {
  const t = harness();
  idleSession(t);
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  const push = (value, seq) => t.onMux({ type: 'session/projection', sessionId: 's1', key: 'contextPressure', value, seq }, {});
  push({ projectedTokens: 164_000, contextWindow: 200_000 }, 1);
  assert.equal(t.subtitle(), 'Context 82%');
  assert.equal(t.el('#subtitle').classList.contains('warn'), true);
  assert.equal(t.el('#subtitle').classList.contains('danger'), false);
  push({ projectedTokens: 194_000, contextWindow: 200_000 }, 2);
  assert.equal(t.subtitle(), 'Context 97%');
  assert.equal(t.el('#subtitle').classList.contains('danger'), true);
});

test('with no session the header renderer leaves the page alone', () => {
  const t = harness();
  t.renderStatusLine();
  assert.equal(t.subtitle(), '');
});

// --- Session details ---------------------------------------------------------
// Every figure the old strip showed has to be present, and only when dsh
// reported it. The details sheet is a reading surface, not a compact line, so
// the table keeps the existing shared columns.

test('details read model, route, context, token buckets, estimate and the turn table', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash'), usageFrame(2, 1, 1, { inputTokens: 1_200, outputTokens: 8_400, cacheReadTokens: 54_000, cacheWriteTokens: 9_000 })]);
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api', agentPreset: 'standard' }];
  await t.openSession('s1');
  const box = t.details();
  const text = textOf(box);
  assert.match(text, /deepseek-flash/);
  assert.match(text, /deepseek-v41/);
  assert.match(text, /standard/);
  assert.match(text, /\/work\/notes-api/);
  assert.match(text, /31%/);
  assert.match(text, /200K/);
  assert.match(text, /in 1\.2K|1\.2K/);
  assert.match(text, /8\.4K/);
  assert.match(text, /54K/);
  assert.match(text, /9K/);
  assert.match(text, /est\. \$0\.0108/);
  assert.deepEqual(tableRows(box), [
    'turn | in | out | read | write | est.',
    '1 | 1.2K | 8.4K | 54K | 9K | $0.0108',
  ]);
});

test('the estimate is the shipped table applied to the reported buckets', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'anthropic', model: 'claude-sonnet-5-5' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'anthropic', 'claude-sonnet-5-5')]);
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  await t.openSession('s1');
  assert.match(textOf(t.details()), /est\. \$0\.1197/);
});

test('an unknown model says n/a rather than a number', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'ollama-cloud', model: 'gpt-oss:120b' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'ollama-cloud', 'gpt-oss:120b')]);
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  await t.openSession('s1');
  const text = textOf(t.details());
  assert.match(text, /gpt-oss:120b/);
  assert.match(text, /ollama-cloud/);
  assert.match(text, /n\/a/);
  assert.doesNotMatch(text, /est\. \$/);
});

test('router labels the details from session.models when the log has no route yet', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'anthropic', model: 'claude-sonnet-5' } };
      if (method === 'session.history') return historyValue([usageFrame(1, 1, 1, { inputTokens: 10, outputTokens: 10 })]);
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  await t.openSession('s1');
  await settle();
  const text = textOf(t.details());
  assert.match(text, /claude-sonnet-5/);
  assert.match(text, /anthropic/);
});

test('the route falls back to the session log when session.models fails', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.history') {
        return historyValue([frame(1, 'request/header', { header: { config: { provider: 'anthropic', model: 'claude-sonnet-5' } }, reason: 'initial' })]);
      }
      return undefined; // session.models 500s
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  await t.openSession('s1');
  await settle();
  const text = textOf(t.details());
  assert.match(text, /claude-sonnet-5/);
  assert.match(text, /anthropic/);
});

test('a user price override replaces the shipped table', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash')]);
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  t.S.prices = { 'deepseek-flash': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  await t.openSession('s1');
  // 1200 + 8400 + 54000 + 9000 = 72600 tokens at $1 per million.
  assert.match(textOf(t.details()), /est\. \$0\.0726/);
});

test('with nothing reported the details say so rather than reading zero', () => {
  const t = harness();
  idleSession(t);
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  t.renderStatusLine();
  assert.equal(t.subtitle(), 'notes-api');

  const box = t.details();
  const text = textOf(box);
  assert.match(text, /Context not reported/);
  assert.match(text, /No per-turn usage reported yet/);
  assert.match(text, /Model prefix: n\/a/);
  assert.doesNotMatch(text, /\$0\.0000/);

  // Pressure without a capacity cannot make a percentage: dsh omits each until
  // its own source has reported.
  t.S.projections.set('s1', new Map([['contextPressure', { seq: -1, value: { pressureTokens: 500 } }]]));
  t.renderStatusLine();
  assert.match(textOf(t.details()), /Context not reported/);

  // Capacity with no usage sample yet is likewise not a reading.
  t.S.projections.set('s1', new Map([['contextPressure', { seq: -1, value: { contextWindow: 200_000 } }]]));
  t.renderStatusLine();
  assert.match(textOf(t.details()), /Context not reported/);
});

test('a session that has spent nothing gets no cost and no invented zero', () => {
  const t = harness();
  idleSession(t);
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  t.S.model.set('s1', { provider: 'deepseek-v41', model: 'deepseek-flash' });
  t.S.projections.set('s1', new Map([
    ['contextPressure', { seq: -1, value: { pressureTokens: 1_000, contextWindow: 200_000 } }],
    ['tokenUsage', { seq: -1, value: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  ]));
  t.renderStatusLine();
  assert.equal(t.subtitle(), 'notes-api · 1%');
  const text = textOf(t.details());
  assert.match(text, /No per-turn usage reported yet/);
  assert.doesNotMatch(text, /\$0\.0000/);
});

test('context fill is clamped at 100% when pressure runs past the window', () => {
  const t = harness();
  idleSession(t);
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  t.S.projections.set('s1', new Map([['contextPressure', { seq: -1, value: { pressureTokens: 250_000, contextWindow: 200_000 } }]]));
  t.renderStatusLine();
  assert.equal(t.subtitle(), 'Context 100%');
});

test('a newer projection frame wins and a stale one is ignored', () => {
  const t = harness();
  idleSession(t);
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  const push = (value, seq) => t.onMux({ type: 'session/projection', sessionId: 's1', key: 'contextPressure', value, seq }, {});
  push({ pressureTokens: 100_000, contextWindow: 200_000 }, 9);
  assert.equal(t.subtitle(), 'notes-api · 50%');
  push({ pressureTokens: 20_000, contextWindow: 200_000 }, 4);
  assert.equal(t.subtitle(), 'notes-api · 50%', 'a stale frame must not regress the value');
  push({ pressureTokens: 20_000, contextWindow: 200_000 }, 12);
  assert.equal(t.subtitle(), 'notes-api · 10%');
});

test('per-turn rows replace a step\'s earlier sample and sum to the session total', () => {
  const t = harness();
  // One step reports twice — an early usage chunk, then the finalized message.
  // Adding both would double-count it; the projection counts it once.
  const turns = t.turnUsage([
    frame(1, 'turn/start', { turn: 1 }),
    frame(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 200 } } }),
    usageFrame(3, 1, 1, { inputTokens: 1_200, outputTokens: 8_400, cacheReadTokens: 54_000, cacheWriteTokens: 9_000 }),
    frame(4, 'turn/end', { turn: 1, reason: { kind: 'done' } }),
    usageFrame(5, 2, 1, { inputTokens: 500, outputTokens: 100 }),
  ]);
  assert.deepEqual(plain(turns.map((x) => x.turn)), [1, 2]);
  assert.deepEqual(plain(turns[0].buckets), SESSION_USAGE);
  assert.deepEqual(plain(turns[1].buckets), { uncachedInputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });

  // The rows have to add up to what the session total reports beside them.
  const total = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const row of turns) for (const key of Object.keys(total)) total[key] += row.buckets[key];
  assert.deepEqual(total, { uncachedInputTokens: 1_700, outputTokens: 8_500, cacheReadTokens: 54_000, cacheWriteTokens: 9_000 });
});

test('a turn with several steps is one row, and a repeated step is not counted twice', () => {
  const t = harness();
  const turns = t.turnUsage([
    usageFrame(1, 3, 1, { inputTokens: 100, outputTokens: 10 }),
    usageFrame(2, 3, 2, { inputTokens: 200, outputTokens: 20 }),
    usageFrame(3, 3, 1, { inputTokens: 100, outputTokens: 10 }),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn, 3);
  assert.deepEqual(plain(turns[0].buckets), { uncachedInputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('the turn table names each bucket and pins the estimate column', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'anthropic', model: 'claude-sonnet-5-5' } };
      if (method === 'session.history') {
        return historyValue([
          routeEvent(1, 'anthropic', 'claude-sonnet-5-5'),
          usageFrame(2, 1, 1, { inputTokens: 1_200, outputTokens: 8_400, cacheReadTokens: 54_000, cacheWriteTokens: 9_000 }),
          usageFrame(3, 2, 1, { inputTokens: 500, outputTokens: 100 }),
        ]);
      }
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  await t.openSession('s1');
  const box = t.details();
  assert.deepEqual(tableRows(box), [
    'turn | in | out | read | write | est.',
    '1 | 1.2K | 8.4K | 54K | 9K | $0.1197',
    '2 | 500 | 100 | 0 | 0 | $0.0020',
  ]);
  assert.ok(notesOf(box).some((n) => /read and write are cache read and cache write/.test(n)));
  assert.ok(notesOf(box).some((n) => /Rows cover loaded history/.test(n)));
});

test('the details say so when earlier turns are not paged in', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') {
        return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash'), usageFrame(2, 4, 1, { inputTokens: 10, outputTokens: 10 })], { hasMore: true });
      }
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  await t.openSession('s1');
  const box = t.details();
  const rows = tableRows(box);
  assert.equal(rows.length, 2);
  assert.match(rows[1], /^4 \|/);
  assert.ok(notesOf(box).some((n) => /Earlier turns are not loaded yet/.test(n)));
});

test('with no usage in the log the details say so instead of showing turns', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash')]);
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  await t.openSession('s1');
  const box = t.details();
  assert.equal(tableRows(box).length, 0);
  assert.ok(notesOf(box).some((n) => /No per-turn usage reported yet/.test(n)));
});

test('the details warn when context is nearly full and keep the session actions', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') {
        return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash')], {
          hasMore: false,
          projections: { contextPressure: { projectedTokens: 164_000, contextWindow: 200_000 }, tokenUsage: SESSION_USAGE },
        });
      }
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api', agentPreset: 'standard' }];
  await t.openSession('s1');
  const text = textOf(t.details());
  assert.match(text, /Context is nearly full/);
  assert.match(text, /Refresh/);
  assert.match(text, /Copy folder path/);
});

test('the title opens the Session details sheet with the same content', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash')]);
      return undefined;
    },
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/notes-api' }];
  await t.openSession('s1');
  t.el('#sessionTitleButton').onclick();
  assert.equal(t.el('#sheet').hidden, false);
  assert.match(textOf(t.el('#sheetTitle')), /Session details/);
  assert.match(textOf(t.el('#sheetBody')), /deepseek-flash/);
  assert.match(textOf(t.el('#sheetBody')), /Estimated cost/);
});
