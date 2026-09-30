import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as prices from '../public/prices.js';

// app.js is a browser script: it reads the DOM at load time and drives everything
// through querySelector, fetch and the two event sockets. The harness below runs
// the real file in a vm context over a small DOM stub, so these tests exercise the
// shipped renderer rather than a copy of its arithmetic.

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
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
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

// The line is a row of segments the CSS lays out with a gap, so the tests read it
// one segment at a time. That also pins the segmentation a phone depends on to
// wrap the line.
const segmentsOf = (el) => el.childNodes.map((n) => textOf(n).trim()).filter(Boolean);
const lineOf = (el) => segmentsOf(el).join(' | ');
// The breakdown renders a grid of cells (six to a row: turn, the four buckets,
// then the estimate) followed by note lines.
const elementKids = (el) => el.childNodes.filter((n) => n.nodeType === 1);
const byClass = (el, re) => elementKids(el).filter((n) => re.test(n.className || ''));
const tableRows = (box) => {
  const table = byClass(box, /status-table/)[0];
  if (!table) return [];
  const cells = elementKids(table).map((n) => textOf(n).trim());
  const rows = [];
  for (let i = 0; i < cells.length; i += 6) rows.push(cells.slice(i, i + 6).join(' | '));
  return rows;
};
const notesOf = (box) => byClass(box, /status-note/).map((n) => textOf(n).trim());

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
  const epilogue = '\n;globalThis.__t = { S, renderStatusLine, turnUsage, openSession, onMux };';
  vm.runInContext(APP + epilogue, context, { filename: 'public/app.js' });
  const t = context.__t;
  t.el = (sel) => document.querySelector(sel);
  t.line = () => lineOf(document.querySelector('#statusSummary'));
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

test('the line reads model, route, context fill, tokens and estimated cost', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash')]);
      return undefined;
    },
  });
  await t.openSession('s1');
  // 61234 of 200000 is 30.6% -> 31%, taken from projectedTokens rather than the
  // bare sample so that a compaction shows immediately.
  assert.equal(t.line(), 'deepseek-flash · deepseek-v41 | 31% | in 1.2K · out 8.4K · cache read 54K · cache write 9K | est. $0.0108');
  assert.equal(t.el('#statusBar').hidden, false);
});

test('the estimate is the shipped table applied to the reported buckets', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'anthropic', model: 'claude-sonnet-5-5' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'anthropic', 'claude-sonnet-5-5')]);
      return undefined;
    },
  });
  await t.openSession('s1');
  // Sonnet 5 rates: (1200x2 + 8400x10 + 54000x0.2 + 9000x2.5) / 1e6 = 0.1197
  assert.match(t.line(), /est\. \$0\.1197$/);
});

test('an unknown model says cost n/a rather than a number', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'ollama-cloud', model: 'gpt-oss:120b' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'ollama-cloud', 'gpt-oss:120b')]);
      return undefined;
    },
  });
  await t.openSession('s1');
  assert.equal(t.line(), 'gpt-oss:120b · ollama-cloud | 31% | in 1.2K · out 8.4K · cache read 54K · cache write 9K | cost n/a');
});

test('router labels the line from session.models when the log has no route yet', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'anthropic', model: 'claude-sonnet-5' } };
      if (method === 'session.history') return historyValue([usageFrame(1, 1, 1, { inputTokens: 10, outputTokens: 10 })]);
      return undefined;
    },
  });
  await t.openSession('s1');
  // Before the models call lands the route is unknown, not unpriced, so the line
  // carries no cost claim at all.
  assert.equal(t.line(), '31% | in 1.2K · out 8.4K · cache read 54K · cache write 9K');
  await settle();
  assert.equal(t.line(), 'claude-sonnet-5 · anthropic | 31% | in 1.2K · out 8.4K · cache read 54K · cache write 9K | est. $0.1197');
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
  await t.openSession('s1');
  await settle();
  assert.match(t.line(), /^claude-sonnet-5 · anthropic \|/);
});

test('a user price override replaces the shipped table', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash')]);
      return undefined;
    },
  });
  t.S.prices = { 'deepseek-flash': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  await t.openSession('s1');
  // 1200 + 8400 + 54000 + 9000 = 72600 tokens at $1 per million.
  assert.match(t.line(), /est\. \$0\.0726$/);
});

test('with nothing reported the line stays hidden rather than reading zero', () => {
  const t = harness();
  idleSession(t);
  t.renderStatusLine();
  assert.equal(t.el('#statusBar').hidden, true);
  assert.equal(t.line(), '');

  // Pressure without a capacity cannot make a percentage: dsh omits each until
  // its own source has reported.
  t.S.projections.set('s1', new Map([['contextPressure', { seq: -1, value: { pressureTokens: 500 } }]]));
  t.renderStatusLine();
  assert.equal(t.el('#statusBar').hidden, true);

  // Capacity with no usage sample yet is likewise not a reading.
  t.S.projections.set('s1', new Map([['contextPressure', { seq: -1, value: { contextWindow: 200_000 } }]]));
  t.renderStatusLine();
  assert.equal(t.el('#statusBar').hidden, true);
});

test('a session that has spent nothing gets no token part and no cost', () => {
  const t = harness();
  idleSession(t);
  t.S.model.set('s1', { provider: 'deepseek-v41', model: 'deepseek-flash' });
  t.S.projections.set('s1', new Map([
    ['contextPressure', { seq: -1, value: { pressureTokens: 1_000, contextWindow: 200_000 } }],
    ['tokenUsage', { seq: -1, value: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  ]));
  t.renderStatusLine();
  assert.equal(t.line(), 'deepseek-flash · deepseek-v41 | 1%');
});

test('a bucket dsh did not bill is left out instead of shown as zero', () => {
  const t = harness();
  idleSession(t);
  t.S.model.set('s1', { provider: 'deepseek-v41', model: 'deepseek-flash' });
  t.S.projections.set('s1', new Map([
    ['contextPressure', { seq: -1, value: { pressureTokens: 1_500, contextWindow: 200_000 } }],
    ['tokenUsage', { seq: -1, value: { uncachedInputTokens: 1_500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  ]));
  t.renderStatusLine();
  assert.equal(t.line(), 'deepseek-flash · deepseek-v41 | 1% | in 1.5K | est. $0.0004');
});

test('context fill is clamped at 100% when pressure runs past the window', () => {
  const t = harness();
  idleSession(t);
  t.S.projections.set('s1', new Map([['contextPressure', { seq: -1, value: { pressureTokens: 250_000, contextWindow: 200_000 } }]]));
  t.renderStatusLine();
  assert.equal(t.line(), '100%');
});

test('a newer projection frame wins and a stale one is ignored', () => {
  const t = harness();
  idleSession(t);
  const push = (value, seq) => t.onMux({ type: 'session/projection', sessionId: 's1', key: 'contextPressure', value, seq }, {});
  push({ pressureTokens: 100_000, contextWindow: 200_000 }, 9);
  assert.equal(t.line(), '50%');
  push({ pressureTokens: 20_000, contextWindow: 200_000 }, 4);
  assert.equal(t.line(), '50%', 'a stale frame must not regress the value');
  push({ pressureTokens: 20_000, contextWindow: 200_000 }, 12);
  assert.equal(t.line(), '10%');
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

  // The rows have to add up to what the session line reports beside them.
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

test('tapping the line expands the breakdown, then collapses it', async () => {
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
  await t.openSession('s1');
  assert.equal(t.el('#statusBreakdown').hidden, true);
  assert.equal(t.el('#statusLine').getAttribute('aria-expanded'), 'false');

  t.el('#statusLine').onclick();
  assert.equal(t.el('#statusBreakdown').hidden, false);
  assert.equal(t.el('#statusLine').getAttribute('aria-expanded'), 'true');
  const rows = tableRows(t.el('#statusBreakdown'));
  // A header row, then one row per turn. Turn 1 carries the same 0.1197 the line
  // above reports; turn 2's absent cache buckets read as 0 in a shared column.
  assert.deepEqual(rows, [
    'turn | in | out | read | write | est.',
    '1 | 1.2K | 8.4K | 54K | 9K | $0.1197',
    '2 | 500 | 100 | 0 | 0 | $0.0020',
  ]);
  assert.deepEqual(notesOf(t.el('#statusBreakdown')), ['read and write are cache read and cache write.']);

  t.el('#statusLine').onclick();
  assert.equal(t.el('#statusBreakdown').hidden, true);
  assert.equal(t.el('#statusLine').getAttribute('aria-expanded'), 'false');
});

test('the breakdown says so when earlier turns are not paged in', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') {
        return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash'), usageFrame(2, 4, 1, { inputTokens: 10, outputTokens: 10 })], { hasMore: true });
      }
      return undefined;
    },
  });
  await t.openSession('s1');
  t.el('#statusLine').onclick();
  const rows = tableRows(t.el('#statusBreakdown'));
  assert.equal(rows.length, 2);
  assert.match(rows[1], /^4 \|/);
  assert.equal(notesOf(t.el('#statusBreakdown')).at(-1), 'Earlier turns are not loaded yet.');
});

test('with no usage in the log the breakdown says so instead of showing turns', async () => {
  const t = harness({
    respond: (method) => {
      if (method === 'session.models') return { current: { provider: 'deepseek-v41', model: 'deepseek-flash' } };
      if (method === 'session.history') return historyValue([routeEvent(1, 'deepseek-v41', 'deepseek-flash')]);
      return undefined;
    },
  });
  await t.openSession('s1');
  t.el('#statusLine').onclick();
  assert.equal(textOf(t.el('#statusBreakdown')).trim(), 'No per-turn usage reported yet.');
});
