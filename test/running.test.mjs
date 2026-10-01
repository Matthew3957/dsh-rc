import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as prices from '../public/prices.js';
import * as actions from '../public/session-actions.js';

// The Running now section is rendered from the same browser script the page
// loads. This harness runs the real public/app.js in a vm over a small DOM stub
// (the same approach as statusline.test.mjs), so the tests exercise the shipped
// renderer and the wire shapes dsh actually sends.

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
    style: { _p: {}, setProperty(k, v) { this._p[k] = v; }, removeProperty(k) { delete this._p[k]; }, getPropertyValue(k) { return this._p[k] || ''; } },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(name, fn) { el['on' + name] = fn; },
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

function textOf(node) {
  if (typeof node === 'string') return node;
  if (node == null || typeof node === 'number') return node == null ? '' : String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.childNodes) return node.childNodes.map(textOf).join('');
  return '';
}
// Elements created by h() live only in the tree, so tests walk it by class.
function allByClass(root, cls) {
  const out = [];
  const walk = (n) => {
    if (!n || n.nodeType !== 1) return;
    if (String(n.className || '').split(/\s+/).includes(cls)) out.push(n);
    for (const k of n.childNodes || []) walk(k);
  };
  walk(root);
  return out;
}
const oneByClass = (root, cls) => allByClass(root, cls)[0];
const elementKids = (el) => (el.childNodes || []).filter((n) => n.nodeType === 1);
const isLive = (el) => el.hidden === true || el.hidden === '';

const plain = (o) => JSON.parse(JSON.stringify(o));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }

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
    dshActions: actions,
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
  const epilogue = '\n;globalThis.__t = { S, renderDashboard, scheduleDashboard, onMux, onHost, loadSessions, fmtElapsed, activeSessions, liveJobs, toggleDashCard, jobRow, handleJobOutput, mergeJob, watchDashJobs, post, get dsh2() { return dsh2; }, setDsh2(v) { dsh2 = v; } };';
  vm.runInContext(APP + epilogue, context, { filename: 'public/app.js' });
  const t = context.__t;
  t.el = (sel) => document.querySelector(sel);
  t.cards = () => elementKids(document.querySelector('#runningCards'));
  t.card = (id) => t.cards().find((c) => c.getAttribute('data-session') === id);
  t.fetchCalls = fetchCalls;
  return t;
}

// --- Real dsh shapes ---------------------------------------------------------
// A `session.list` row carries the projection baseline for one session. The
// values below are the wire views of dsh's own projection units: `todos` from
// dsh-tool-todo, `contextPressure`/`tokenUsage` from dsh-token-meter,
// `sessionListMetadata` and the `title` cell from the API proxy itself.

const T0 = 1_700_000_000_000;
const PROMPT_AT = T0 - 60_000;

function summary(over = {}) {
  return {
    sessionId: 's1',
    updatedAt: T0,
    running: true,
    blank: false,
    cwd: '/work/project',
    agentPreset: 'standard',
    projections: {
      asOfSeq: 10,
      values: {
        title: 'Fix the bug',
        todos: [
          { content: 'Read the code', status: 'completed' },
          { content: 'Patch the parser', status: 'in_progress' },
          { content: 'Run the tests', status: 'pending' },
        ],
        contextPressure: { pressureTokens: 25_000, projectedTokens: 25_000, contextWindow: 100_000 },
        sessionListMetadata: { blank: false, lastPromptAt: PROMPT_AT },
      },
    },
    ...over,
  };
}

const childEntry = (over = {}) => ({
  kind: 'child', id: 'sub-1', mode: 'one-shot', label: 'Run the tests', activity: 'running', hasChildren: false, ...over,
});

const jobsFrame = (sessionId, jobs) => ({ type: 'session/jobs', sessionId, jobs });
const runningJob = (over = {}) => ({ id: 'bash-1', kind: 'bash', label: 'sleep 180', status: 'running', startedAt: T0 - 5_000, ...over });

test('fmtElapsed counts up in the units a glance needs', () => {
  const t = harness();
  assert.equal(t.fmtElapsed(0), '0s');
  assert.equal(t.fmtElapsed(9_400), '9s');
  assert.equal(t.fmtElapsed(59_999), '59s');
  assert.equal(t.fmtElapsed(61_000), '1m 01s');
  assert.equal(t.fmtElapsed(3_725_000), '1h 02m');
  assert.equal(t.fmtElapsed(90_000_000), '1d 01h');
  assert.equal(t.fmtElapsed(-5), '0s');
  assert.equal(t.fmtElapsed(NaN), '0s');
});

test('with nothing running the section stays out of the way', () => {
  const t = harness();
  t.renderDashboard();
  assert.equal(t.el('#running').hidden, true);
});

test('a running session shows title, todo progress, the active todo and context fill', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  assert.equal(t.el('#running').hidden, false);
  assert.equal(t.el('#runningCount').textContent, '1');
  const card = t.card('s1');
  assert.ok(card, 'a card for the running session');
  assert.match(textOf(oneByClass(card, 'run-name')), /Fix the bug/);
  // 1 of 3 todos done, 25K of 100K context.
  const meters = allByClass(card, 'run-meter').map((m) => textOf(m));
  assert.deepEqual(meters, ['todos1/3', 'ctx25%']);
  assert.equal(textOf(oneByClass(card, 'run-current')), 'Patch the parser');
  // The elapsed origin is the last human prompt from the list baseline.
  assert.equal(oneByClass(card, 'run-elapsed').getAttribute('data-since'), String(PROMPT_AT));
});

test('the section opens with its progress cards when something runs and the head folds it', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  assert.equal(t.el('#running').hidden, false, 'an active session shows the section');
  assert.equal(isLive(t.el('#runningCards')), false, 'the cards, with their progress bars, show by default');
  assert.equal(t.el('#runningHead').getAttribute('aria-expanded'), 'true');
  // The head is a flex row; folding it is a state flip plus a render.
  t.el('#runningHead').onclick();
  assert.equal(isLive(t.el('#runningCards')), true);
  assert.equal(t.el('#runningHead').getAttribute('aria-expanded'), 'false');
});

test('a session/jobs frame fills the job list', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  t.onMux(jobsFrame('s1', [runningJob()]), {});
  t.renderDashboard();
  const card = t.card('s1');
  assert.match(textOf(oneByClass(card, 'run-more')), /1 running job/);
  // Expanded card shows the job rows; the row is complete enough to place the work.
  t.toggleDashCard('s1');
  const job = oneByClass(t.card('s1'), 'run-job');
  assert.equal(textOf(oneByClass(job, 'jkind')), 'bash');
  assert.equal(textOf(oneByClass(job, 'jlabel')), 'sleep 180');
  assert.equal(oneByClass(job, 'jtime').getAttribute('data-since'), String(T0 - 5_000));
});

test('an emptied jobs frame removes the jobs and the card when nothing else runs', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary({ running: false })] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  assert.equal(t.el('#running').hidden, true, 'an idle session is not active');
  t.onMux(jobsFrame('s1', [runningJob()]), {});
  t.renderDashboard();
  assert.equal(t.el('#running').hidden, false, 'a live job makes an idle session active');
  t.onMux(jobsFrame('s1', []), {});
  t.renderDashboard();
  assert.equal(t.S.jobs.has('s1'), false);
  assert.equal(t.el('#running').hidden, true);
});

test('a live background job keeps a session on the dashboard after its turn ends', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary({ running: true })] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  t.onMux(jobsFrame('s1', [runningJob()]), {});
  t.onMux({ type: 'session/event', sessionId: 's1', event: { seq: 9, time: T0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }, {});
  t.renderDashboard();
  assert.equal(t.el('#running').hidden, false);
  assert.equal(t.card('s1') && t.card('s1').getAttribute('data-session'), 's1');
  // The dot goes idle: the turn is over even though the job is still live.
  assert.match(oneByClass(t.card('s1'), 'run-dot').className, /idle/);
});

test('the subagent tree comes from subagent.list and timing from its projection', async () => {
  const t = harness({
    respond: (m) => {
      if (m === 'session.list') return { items: [summary()] };
      if (m === 'subagent.list') return { entries: [childEntry()], parentAvailable: true };
      return undefined;
    },
  });
  await t.loadSessions();
  await settle();
  t.renderDashboard();
  t.toggleDashCard('s1');
  const card = t.card('s1');
  assert.match(textOf(oneByClass(card, 'run-more')), /1 subagent/);
  const row = oneByClass(card, 'run-agent');
  assert.equal(textOf(oneByClass(row, 'aname')), 'Run the tests');
  assert.equal(textOf(oneByClass(row, 'amode')), 'one-shot');
  assert.match(oneByClass(row, 'adot').className, /running/);
  // dsh-subagent's `subagentTiming` view: an open interval while the child turns.
  t.onMux({ type: 'session/projection', sessionId: 'sub-1', key: 'subagentTiming', value: { settledMs: 0, active: { since: PROMPT_AT, through: T0 } }, seq: 4 }, {});
  t.renderDashboard();
  assert.equal(oneByClass(t.card('s1'), 'atime').getAttribute('data-since'), String(PROMPT_AT));
});

test('a child with its own catalog is followed down to its children', async () => {
  const t = harness({
    respond: (m, body) => {
      if (m === 'session.list') return { items: [summary()] };
      if (m === 'subagent.list') {
        if (body.payload.parentSessionId === 's1') return { entries: [childEntry({ hasChildren: true })], parentAvailable: true };
        if (body.payload.parentSessionId === 'sub-1') return { entries: [childEntry({ id: 'sub-2', label: 'Grandchild', mode: 'continuable', hasChildren: false })], parentAvailable: true };
      }
      return undefined;
    },
  });
  await t.loadSessions();
  await settle();
  t.renderDashboard();
  t.toggleDashCard('s1');
  const rows = allByClass(t.card('s1'), 'run-agent');
  assert.deepEqual(rows.map((r) => textOf(oneByClass(r, 'aname'))), ['Run the tests', 'Grandchild']);
  assert.deepEqual(rows.map((r) => r.style.getPropertyValue('--depth')), ['0', '1']);
});

test('a settled subagent shows its accumulated time instead of a live clock', async () => {
  const t = harness({
    respond: (m) => {
      if (m === 'session.list') return { items: [summary({ running: false })] };
      if (m === 'subagent.list') return { entries: [childEntry({ activity: 'inactive' })], parentAvailable: true };
      return undefined;
    },
  });
  // Without a running turn the session is only active through something else;
  // a live job stands in for the parent still waiting on the child.
  t.onMux(jobsFrame('s1', [runningJob()]), {});
  await t.loadSessions();
  await settle();
  t.S.projections.set('sub-1', new Map([['subagentTiming', { seq: 9, value: { settledMs: 125_503 } }]]));
  t.renderDashboard();
  t.toggleDashCard('s1');
  const row = oneByClass(t.card('s1'), 'run-agent');
  assert.equal(textOf(oneByClass(row, 'atime')), '2m 05s');
  assert.equal(oneByClass(row, 'atime').getAttribute('data-since'), undefined);
  assert.match(oneByClass(row, 'adot').className, /settled/);
});

// The order dsh 0.2.0-rc.2 sends when a turn spawns one background subagent and ends
// right away (checked live): the parent's tree is read while it runs and before the child
// exists, then the child is added and starts, the parent's catalog grows, and the
// parent's turn ends. Nothing else arrives until the child settles.
function spawnWorld() {
  const world = { children: [] };
  const t = harness({
    respond: (m, body) => {
      if (m === 'session.list') return { items: [summary()] };
      if (m === 'subagent.list') return { entries: body.payload.parentSessionId === 's1' ? world.children : [], parentAvailable: true };
      return undefined;
    },
  });
  return { t, world };
}
async function spawnBackgroundChild(t, world, { catalogPush = true } = {}) {
  await t.loadSessions();
  await settle();
  t.renderDashboard();
  await settle();
  t.onHost({ type: 'host/session-added', sessionId: 'sub-1', parentSessionId: 's1', origin: 'subagent', blank: true, running: false });
  world.children = [childEntry({ mode: 'continuable', label: 'sleep then done' })];
  t.onHost({ type: 'host/session-status', sessionId: 'sub-1', running: true });
  if (catalogPush) t.onMux({ type: 'session/projection', sessionId: 's1', key: 'subagentCatalog', value: [{ id: 'sub-1', mode: 'continuable', label: 'sleep then done', createdAt: T0 }], seq: 20 }, {});
  t.onHost({ type: 'host/session-status', sessionId: 's1', running: false });
  await settle();
  t.renderDashboard();
}

test('a background subagent keeps its parent in Running now after the parent turn ends', async () => {
  const { t, world } = spawnWorld();
  await spawnBackgroundChild(t, world);
  assert.equal(t.el('#running').hidden, false);
  t.toggleDashCard('s1');
  const card = t.card('s1');
  assert.match(textOf(oneByClass(card, 'run-more')), /1 subagent/);
  const row = oneByClass(card, 'run-agent');
  assert.equal(textOf(oneByClass(row, 'aname')), 'sleep then done');
  assert.match(oneByClass(row, 'adot').className, /running/);
});

test('the child settling takes the parent off Running now', async () => {
  const { t, world } = spawnWorld();
  await spawnBackgroundChild(t, world);
  assert.equal(t.el('#running').hidden, false);
  world.children = [childEntry({ mode: 'continuable', label: 'sleep then done', activity: 'inactive' })];
  t.onHost({ type: 'host/session-status', sessionId: 'sub-1', running: false });
  await settle();
  t.renderDashboard();
  assert.equal(t.el('#running').hidden, true);
});

test('without a catalog push a known child starting still refreshes its parent tree', async () => {
  const { t, world } = spawnWorld();
  await spawnBackgroundChild(t, world, { catalogPush: false });
  assert.equal(t.el('#running').hidden, false);
  assert.ok(t.card('s1'));
});

test('a child turn/start seen on the mux is tracked for a session the chat view never opens', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  const since = Date.now() - 61_000;
  t.onMux({ type: 'session/event', sessionId: 's1', event: { seq: 11, time: since, type: 'turn/start', data: { turn: 1 } } }, {});
  t.renderDashboard();
  const elapsed = oneByClass(t.card('s1'), 'run-elapsed');
  assert.equal(elapsed.getAttribute('data-since'), String(since));
  assert.match(textOf(elapsed), /^1m \d\ds$/);
  assert.equal(t.S.turnStart.get('s1'), since);
});

test('a turn/start for a session the list never returned reloads the list', async () => {
  let listed = false;
  const t = harness({
    respond: (m) => {
      if (m === 'session.list') return { items: listed ? [summary()] : [] };
      if (m === 'subagent.list') return { entries: [], parentAvailable: true };
      return undefined;
    },
  });
  await t.loadSessions();
  assert.equal(t.el('#running').hidden, true);
  // A session created by another client was blank when host/session-added fired,
  // so its first turn is the first time it can appear.
  listed = true;
  t.onMux({ type: 'session/event', sessionId: 's1', event: { seq: 1, time: T0, type: 'turn/start', data: { turn: 1 } } }, {});
  await settle();
  t.renderDashboard();
  assert.equal(t.el('#running').hidden, false);
  assert.equal(t.card('s1') && t.card('s1').getAttribute('data-session'), 's1');
});

test('a projection frame updates the card without rebuilding one whose data did not move', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  const first = t.card('s1');
  t.renderDashboard();
  assert.equal(t.card('s1'), first, 'unchanged data keeps the same DOM');
  t.onMux({ type: 'session/projection', sessionId: 's1', key: 'todos', value: [{ content: 'Read the code', status: 'completed' }], seq: 12 }, {});
  t.renderDashboard();
  assert.notEqual(t.card('s1'), first, 'a changed projection rebuilds the card');
  assert.deepEqual(allByClass(t.card('s1'), 'run-meter').map((m) => textOf(m)), ['todos1/1', 'ctx25%']);
});

test('the list baseline never overwrites a newer live projection value', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  t.onMux({ type: 'session/projection', sessionId: 's1', key: 'todos', value: [{ content: 'live', status: 'completed' }], seq: 40 }, {});
  await t.loadSessions();
  const todos = t.S.projections.get('s1').get('todos');
  assert.equal(todos.seq, 40);
  assert.deepEqual(plain(todos.value), [{ content: 'live', status: 'completed' }]);
});

test('a subagent child session is not a card of its own', async () => {
  const t = harness({
    respond: (m) => {
      if (m === 'session.list') return {
        items: [
          summary(),
          { sessionId: 'sub-1', updatedAt: T0, running: true, blank: false, cwd: '/work/project', parentSessionId: 's1', origin: 'subagent' },
        ],
      };
      if (m === 'subagent.list') return { entries: [childEntry()], parentAvailable: true };
      return undefined;
    },
  });
  await t.loadSessions();
  await settle();
  t.renderDashboard();
  assert.equal(t.cards().length, 1);
  assert.equal(t.card('sub-1'), undefined);
});

test('an idle session with neither a turn nor a job stays off the dashboard', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [{ sessionId: 's9', updatedAt: T0, running: false, blank: false, cwd: '/work/idle' }] } : undefined) });
  await t.loadSessions();
  assert.equal(t.el('#running').hidden, true);
  assert.equal(t.activeSessions().length, 0);
});

test('archived sessions leave the list and a fork with lineage stays in it', async () => {
  const rows = [
    { sessionId: 'a1', updatedAt: T0, running: false, blank: false, cwd: '/work/a' },
    { sessionId: 'f1', updatedAt: T0, running: false, blank: false, cwd: '/work/a', parentSessionId: 'a1' },
    { sessionId: 'k1', updatedAt: T0, running: false, blank: false, cwd: '/work/a', parentSessionId: 'a1', origin: 'subagent' },
  ];
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: rows } : m === 'workspace.list' ? { items: [], archivedSessionIds: ['a1'] } : undefined) });
  await t.loadSessions();
  assert.deepEqual(plain(t.S.sessions.map((s) => s.sessionId)), ['f1']);
  t.onHost({ type: 'host/archived-sessions-changed', archivedSessionIds: ['a1', 'f1'] });
  assert.equal(t.S.sessions.length, 0);
});

// --- dsh 0.2: the page watches the sessions it lists, shows their jobs from
// public/dsh02.js's session/jobs frames, and offers the 0.2-only controls ---

const fakeDsh2 = (t, over = {}) => ({
  rpc: (method, payload, rpcId) => t.post(method, payload, rpcId),
  connect() {},
  isOpen: () => true,
  watchJobs: () => {},
  observeJob: () => {},
  stopObserve: () => {},
  killJob: async () => ({ outcome: 'requested' }),
  ...over,
});

test('the 0.2 adapter is asked to watch exactly the sessions the page lists', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : undefined) });
  const watched = [];
  t.setDsh2(fakeDsh2(t, { watchJobs: (ids) => watched.push(ids) }));
  await t.loadSessions();
  assert.deepEqual(plain(watched.at(-1)), ['s1']);
});

test('a 0.2 job row shows elapsed time and stops on the second tap', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : undefined) });
  const killed = [];
  t.setDsh2(fakeDsh2(t, { killJob: async (sessionId, jobId) => { killed.push([sessionId, jobId]); return { outcome: 'requested' }; } }));
  await t.loadSessions();
  t.onMux(jobsFrame('s1', [runningJob()]), {});
  t.renderDashboard();
  t.toggleDashCard('s1');
  const job = oneByClass(t.card('s1'), 'run-job');
  assert.equal(oneByClass(job, 'jtime').getAttribute('data-since'), String(T0 - 5_000));
  const stop = oneByClass(job, 'jstop');
  assert.ok(stop, 'the running job carries a stop control on 0.2');
  await stop.onclick();
  assert.equal(stop.textContent, 'sure?');
  assert.deepEqual(killed, [], 'the first tap only arms');
  await stop.onclick();
  assert.deepEqual(plain(killed), [['s1', 'bash-1']]);
});

test('tapping a 0.2 job row follows its output and the pane fills from the stream', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : undefined) });
  const observed = [];
  t.setDsh2(fakeDsh2(t, {
    observeJob: (sessionId, jobId) => observed.push(['observe', sessionId, jobId]),
    stopObserve: (jobId) => observed.push(['stop', jobId]),
  }));
  await t.loadSessions();
  t.onMux(jobsFrame('s1', [runningJob()]), {});
  t.renderDashboard();
  t.toggleDashCard('s1');
  oneByClass(t.card('s1'), 'jtoggle').onclick();
  assert.deepEqual(observed, [['observe', 's1', 'bash-1']]);
  assert.equal(t.S.jobOpen.has('bash-1'), true);
  t.onMux({ type: 'job/output', sessionId: 's1', jobId: 'bash-1', kind: 'opened', job: runningJob() }, {});
  t.onMux({ type: 'job/output', sessionId: 's1', jobId: 'bash-1', kind: 'output', chunks: [{ at: 0, text: 'line 1\n' }, { at: 7, text: 'line 2\n', gapBefore: true }], lossy: false }, {});
  assert.equal(t.S.jobOut.get('bash-1').text, 'line 1\nline 2\n');
  assert.equal(t.S.jobOut.get('bash-1').gap, true);
  t.renderDashboard();
  assert.equal(oneByClass(t.card('s1'), 'jout').textContent, 'line 1\nline 2\n');
  // The terminal status settles the row with its exit status and ends the live clock.
  t.onMux({ type: 'job/output', sessionId: 's1', jobId: 'bash-1', kind: 'status', job: { id: 'bash-1', kind: 'bash', label: 'sleep 180', status: 'completed', detail: 'exit code: 0', startedAt: T0 - 5_000, finishedAt: T0 } }, {});
  assert.equal(t.S.jobOut.get('bash-1').streaming, false);
  assert.equal(t.S.jobs.get('s1')[0].status, 'completed');
  assert.equal(t.S.jobs.get('s1')[0].detail, 'exit code: 0');
  t.renderDashboard();
  assert.match(textOf(oneByClass(t.card('s1'), 'jtime')), /completed · exit code: 0/);
  // Collapsing the pane stops the follow.
  oneByClass(t.card('s1'), 'jtoggle').onclick();
  assert.equal(t.S.jobOpen.has('bash-1'), false);
  assert.deepEqual(observed.at(-1), ['stop', 'bash-1']);
});

test('without the 0.2 adapter a job row keeps its quiet 0.1 shape', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : undefined) });
  await t.loadSessions();
  t.onMux(jobsFrame('s1', [runningJob({ output: { total: 9, earliest: 0 } })]), {});
  t.renderDashboard();
  t.toggleDashCard('s1');
  const job = oneByClass(t.card('s1'), 'run-job');
  assert.equal(oneByClass(job, 'jstop'), undefined);
  assert.equal(oneByClass(job, 'jtoggle'), undefined);
  assert.equal(textOf(oneByClass(job, 'jlabel')), 'sleep 180');
});

test('a job the roster drops has its output read stopped and its pane forgotten', () => {
  const t = harness();
  const stopped = [];
  t.setDsh2(fakeDsh2(t, { stopObserve: (jobId) => stopped.push(jobId) }));
  t.S.jobs.set('s1', [{ id: 'bash-1', status: 'running' }]);
  t.S.jobOut.set('bash-1', { text: 'x', streaming: true });
  t.S.jobOpen.add('bash-1');
  t.onMux(jobsFrame('s1', []), {});
  assert.equal(t.S.jobs.has('s1'), false);
  assert.equal(t.S.jobOut.has('bash-1'), false);
  assert.equal(t.S.jobOpen.has('bash-1'), false);
  assert.deepEqual(stopped, ['bash-1']);
});

test('a terminal output status never resurrects a job the roster no longer has', () => {
  const t = harness();
  t.mergeJob('s1', { id: 'bash-1', status: 'completed' });
  assert.equal(t.S.jobs.has('s1'), false);
  t.S.jobs.set('s1', [{ id: 'bash-1', status: 'running', label: 'x' }]);
  t.mergeJob('s1', { id: 'bash-1', status: 'completed', detail: 'exit code: 0' });
  assert.equal(t.S.jobs.get('s1')[0].status, 'completed');
  assert.equal(t.S.jobs.get('s1')[0].detail, 'exit code: 0');
  assert.equal(t.S.jobs.get('s1')[0].label, 'x', 'the roster row keeps its other fields');
});
