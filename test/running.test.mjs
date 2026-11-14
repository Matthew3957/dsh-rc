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

function harness({ respond, http } = {}) {
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
  const httpCalls = [];
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
      // dsh-rc's own read-only endpoints (the Claude transcript views) answer plain JSON.
      if (/^\.\/claude\//.test(String(url))) {
        httpCalls.push(String(url));
        const r = http ? http(String(url)) : undefined;
        const status = r ? r.status || 200 : 404;
        return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => (r ? r.body : null) };
      }
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
  const epilogue = '\n;globalThis.__t = { S, renderDashboard, scheduleDashboard, onMux, onHost, loadSessions, fmtElapsed, activeSessions, liveJobs, toggleDashCard, jobRow, handleJobOutput, mergeJob, watchDashJobs, post, claudeTick, claudeRuns, get claudeFeed() { return claudeFeed; }, get claudeTimer() { return claudeTimer; }, stopClaudeFeed, get dsh2() { return dsh2; }, setDsh2(v) { dsh2 = v; } };';
  vm.runInContext(APP + epilogue, context, { filename: 'public/app.js' });
  const t = context.__t;
  t.el = (sel) => document.querySelector(sel);
  t.cards = () => elementKids(document.querySelector('#runningCards'));
  t.card = (id) => t.cards().find((c) => c.getAttribute('data-session') === id);
  t.fetchCalls = fetchCalls;
  t.httpCalls = httpCalls;
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

// --- external Claude Code subagents: a live feed from dsh-rc's transcript views ---

const RUN_A = 'RunAAAAAAAAAAAAA';
const RUN_B = 'RunBBBBBBBBBBBBB';
// The catalog's `name` is the sibling name the model chose, never the tool that ran the run, and
// an external row's `activity` is always inactive: it has no session of its own.
const extEntry = (over = {}) => childEntry({ id: 'ext-1', mode: 'external', label: 'Review the parser module', activity: 'inactive', createdAt: T0, name: 'agent-1', ...over });

// A tiny dsh-rc: /claude/runs lists transcripts by start time, /claude/runs/<id> answers
// events from an offset, the way server/claude-transcripts.mjs does. `mtimes` is each file's
// modification time (an old one by default, so a run is quiet unless a test says otherwise).
function claudeServer({ enabled = true, runs = [], feeds = {}, mtimes = {} } = {}) {
  const srv = { enabled, runs, feeds, mtimes, reads: [] };
  srv.http = (url) => {
    const u = new URL(url, 'http://x/');
    if (u.pathname === '/claude/runs') {
      if (!srv.enabled) return { body: { enabled: false, runs: [] } };
      const since = Number(u.searchParams.get('since'));
      const list = srv.runs.filter((r) => r.cwd === u.searchParams.get('cwd') && Math.abs(r.startedAt - since) <= 30_000)
        .sort((a, b) => Math.abs(a.startedAt - since) - Math.abs(b.startedAt - since))
        .map(({ id, startedAt, prompt }) => ({ id, startedAt, updatedAt: startedAt, prompt }));
      return { body: { enabled: true, runs: list } };
    }
    const m = /^\/claude\/runs\/([^/]+)$/.exec(u.pathname);
    const feed = m && srv.feeds[m[1]];
    if (!feed) return { status: 404, body: { error: 'unknown run' } };
    const offset = u.searchParams.has('offset') ? Number(u.searchParams.get('offset')) : null;
    srv.reads.push([m[1], offset]);
    return { body: { events: feed.slice(offset == null ? 0 : offset), offset: feed.length, size: feed.length, updatedAt: srv.mtimes[m[1]] ?? T0, reset: offset == null } };
  };
  return srv;
}
function externalWorld(entries, srv) {
  return harness({
    http: srv.http,
    respond: (m) => {
      if (m === 'session.list') return { items: [summary()] };
      if (m === 'subagent.list') return { entries, parentAvailable: true };
      return undefined;
    },
  });
}
// The list loads, the subagent tree arrives, and the first round of matching runs, with
// the card left folded.
async function loadExternal(t) {
  await t.loadSessions();
  await settle();
  t.renderDashboard();
  await settle(10);
}
async function openExternal(t) {
  await loadExternal(t);
  t.toggleDashCard('s1');
  await settle(10);
}
const feedLines = (card) => allByClass(card, 'ce').map((el) => textOf(el));
const extDot = (t, name) => {
  const row = allByClass(t.card('s1'), 'run-agent').find((r) => textOf(oneByClass(r, 'aname')) === name);
  return oneByClass(row, 'adot').className;
};
const turnEnd = (t) => t.onMux({ type: 'session/event', sessionId: 's1', event: { seq: 50, time: T0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }, {});
// Pretend `ms` passed since the page last looked at a run: every time it holds moves back.
const elapse = (t, key, ms) => {
  const st = t.claudeRuns.get(key);
  for (const k of ['checkedAt', 'activeAt', 'searchedAt']) if (typeof st[k] === 'number') st[k] -= ms;
};

test('an expanded card shows an external Claude run\'s recent tool calls and text, and follows it by offset', async () => {
  const srv = claudeServer({
    runs: [{ id: RUN_A, cwd: '/work/project', startedAt: T0 + 2_000, prompt: 'Review the parser module for bugs' }],
    feeds: { [RUN_A]: [
      { k: 'tool', id: 'tu1', text: 'Read: server/parser.mjs', at: T0 },
      { k: 'result', id: 'tu1', ok: true, at: T0 },
      { k: 'text', text: 'The parser drops the last token.', at: T0 },
    ] },
    mtimes: { [RUN_A]: Date.now() },
  });
  const t = externalWorld([extEntry()], srv);
  await openExternal(t);
  const card = t.card('s1');
  assert.equal(textOf(oneByClass(card, 'aname')), 'Review the parser module');
  const panel = oneByClass(card, 'run-claude');
  assert.ok(panel, 'the external row carries a feed panel');
  assert.equal(panel.hidden, false);
  assert.deepEqual(feedLines(card), ['✓Read: server/parser.mjs', '“The parser drops the last token.']);
  assert.ok(t.httpCalls[0].startsWith('./claude/runs?cwd=%2Fwork%2Fproject&since=' + T0));
  assert.deepEqual(srv.reads, [[RUN_A, null]]);

  // New lines arrive; the next round asks only for what follows the last offset.
  srv.feeds[RUN_A].push({ k: 'tool', id: 'tu2', text: 'Bash: npm test', at: T0 }, { k: 'result', id: 'tu2', ok: false, text: 'Exit code 1', at: T0 });
  await t.claudeTick();
  assert.deepEqual(srv.reads.at(-1), [RUN_A, 3]);
  assert.equal(feedLines(t.card('s1')).at(-1), '✗Bash: npm test');
  assert.equal(t.card('s1'), card, 'the feed updates in place without rebuilding the card');
  assert.ok(t.claudeTimer, 'polling runs while the card is open');
  t.stopClaudeFeed();
});

test('a folded card or section drops the panel and reads only at the slower pace, and an open chat stops the feed', async () => {
  const srv = claudeServer({ runs: [{ id: RUN_A, cwd: '/work/project', startedAt: T0, prompt: 'x' }], feeds: { [RUN_A]: [{ k: 'text', text: 'hi' }] } });
  const t = externalWorld([extEntry()], srv);
  await openExternal(t);
  assert.ok(t.claudeTimer);
  const key = 's1\u0000ext-1';
  // Expanded: every round reads.
  let before = srv.reads.length;
  await t.claudeTick();
  assert.equal(srv.reads.length, before + 1);

  t.toggleDashCard('s1');
  assert.equal(allByClass(t.card('s1'), 'run-claude').length, 0, 'a folded card has no feed panel');
  assert.ok(t.claudeTimer, 'a folded card is still followed for liveness');
  before = t.httpCalls.length;
  await t.claudeTick();
  assert.equal(t.httpCalls.length, before, 'a folded card is not read every 3s round');
  elapse(t, key, 6_000);
  await t.claudeTick();
  assert.equal(t.httpCalls.length, before + 1, 'it is read again once the slower pace has passed');

  t.toggleDashCard('s1');
  t.el('#runningHead').onclick();
  before = t.httpCalls.length;
  await t.claudeTick();
  assert.equal(t.httpCalls.length, before, 'a folded section reads at the slower pace too');

  t.el('#runningHead').onclick();
  t.el('#listView').hidden = true;
  t.renderDashboard();
  assert.equal(t.claudeTimer, null, 'an open chat is not polled');
  before = t.httpCalls.length;
  await t.claudeTick();
  assert.equal(t.httpCalls.length, before);
});

test('without a configured Claude dir nothing appears and nothing more is asked', async () => {
  const srv = claudeServer({ enabled: false });
  const t = externalWorld([extEntry()], srv);
  await openExternal(t);
  assert.equal(t.claudeFeed, false);
  assert.equal(oneByClass(t.card('s1'), 'run-claude').hidden, true);
  assert.equal(t.httpCalls.length, 1);
  t.renderDashboard();
  await t.claudeTick();
  assert.equal(t.httpCalls.length, 1);
  assert.equal(t.claudeTimer, null);
});

test('an external run with no Claude transcript (a Codex or Gemini run) shows nothing and never keeps its card', async () => {
  // The only transcript in the folder started long after either run, so neither matches.
  const srv = claudeServer({ runs: [{ id: RUN_A, cwd: '/work/project', startedAt: T0 + 500_000, prompt: 'far away' }], feeds: { [RUN_A]: [{ k: 'text', text: 'not this one' }] }, mtimes: { [RUN_A]: Date.now() } });
  const other = extEntry({ id: 'ext-2', name: 'agent-2', label: 'Second opinion' });
  const t = externalWorld([other, extEntry()], srv);
  await openExternal(t);
  const card = t.card('s1');
  for (const panel of allByClass(card, 'run-claude')) assert.equal(panel.hidden, true, 'an unmatched run draws no feed');
  assert.ok(t.httpCalls.every((u) => u.startsWith('./claude/runs?')), 'no events were read');
  assert.deepEqual(srv.reads, []);
  assert.match(extDot(t, 'Second opinion'), /settled/);
  turnEnd(t);
  t.renderDashboard();
  assert.equal(t.el('#running').hidden, true, 'an unmatched external run does not keep the parent on the dashboard');
  t.stopClaudeFeed();
});

test('a matched transcript being written shows the external row live', async () => {
  const srv = claudeServer({
    runs: [{ id: RUN_A, cwd: '/work/project', startedAt: T0 + 2_000, prompt: 'Review the parser module for bugs' }],
    feeds: { [RUN_A]: [{ k: 'tool', id: 'tu1', text: 'Read: server/parser.mjs', at: T0 }] },
    mtimes: { [RUN_A]: Date.now() },
  });
  const t = externalWorld([extEntry()], srv);
  await openExternal(t);
  assert.match(extDot(t, 'Review the parser module'), /running/, 'the transcript, not the inactive catalog row, decides the dot');
  assert.deepEqual(feedLines(t.card('s1')), ['›Read: server/parser.mjs']);
  t.stopClaudeFeed();
});

test('external runs are matched while the card is still folded, and the panel waits for it to open', async () => {
  const srv = claudeServer({
    runs: [{ id: RUN_A, cwd: '/work/project', startedAt: T0 + 2_000, prompt: 'Review the parser module for bugs' }],
    feeds: { [RUN_A]: [{ k: 'text', text: 'Looking at the tokenizer.' }] },
    mtimes: { [RUN_A]: Date.now() },
  });
  const t = externalWorld([extEntry()], srv);
  await loadExternal(t);
  assert.equal(t.S.dashOpen.has('s1'), false);
  assert.equal(t.claudeRuns.get('s1\u0000ext-1').runId, RUN_A, 'matched without the card ever opening');
  assert.deepEqual(srv.reads, [[RUN_A, null]]);
  assert.equal(allByClass(t.card('s1'), 'run-claude').length, 0, 'no panel under a folded card');
  assert.match(extDot(t, 'Review the parser module'), /running/);
  const calls = t.httpCalls.length;
  t.toggleDashCard('s1');
  assert.deepEqual(feedLines(t.card('s1')), ['“Looking at the tokenizer.'], 'opening shows what was already read');
  assert.equal(t.httpCalls.length, calls, 'opening alone asks nothing new');
  t.stopClaudeFeed();
});

test('a Claude run still writing keeps its parent in Running now after the parent turn ends, until it goes quiet', async () => {
  const srv = claudeServer({
    runs: [{ id: RUN_A, cwd: '/work/project', startedAt: T0 + 2_000, prompt: 'Review the parser module for bugs' }],
    feeds: { [RUN_A]: [{ k: 'tool', id: 'tu1', text: 'Read: server/parser.mjs', at: T0 }] },
    mtimes: { [RUN_A]: Date.now() },
  });
  const t = externalWorld([extEntry()], srv);
  const key = 's1\u0000ext-1';
  await loadExternal(t);
  turnEnd(t);
  t.renderDashboard();
  assert.equal(t.S.running.get('s1'), false);
  assert.equal(t.el('#running').hidden, false, 'the parent stays while the transcript is live');
  assert.ok(t.card('s1'));
  assert.match(oneByClass(t.card('s1'), 'run-dot').className, /idle/, 'the parent turn itself is over');

  // The transcript keeps growing: the folded card's next read sees it and the card stays.
  srv.feeds[RUN_A].push({ k: 'tool', id: 'tu2', text: 'Bash: npm test', at: T0 });
  srv.mtimes[RUN_A] = Date.now();
  elapse(t, key, 6_000);
  await t.claudeTick();
  assert.deepEqual(srv.reads.at(-1), [RUN_A, 1]);
  t.renderDashboard();
  assert.equal(t.el('#running').hidden, false);
  assert.ok(t.claudeTimer);

  // Five quiet minutes later, with nothing appended, the run settles and the card goes.
  elapse(t, key, 6 * 60_000);
  await t.claudeTick();
  assert.equal(t.el('#running').hidden, true, 'a transcript that stopped being written no longer keeps the card');
  await t.claudeTick();
  assert.equal(t.claudeTimer, null, 'and nothing is followed any more');
});

test('only the eight most recent external runs of a session are looked up', async () => {
  const srv = claudeServer();
  const entries = Array.from({ length: 10 }, (_, i) => extEntry({ id: 'ext-' + i, label: 'Task number ' + i, name: 'agent-' + (i + 1), createdAt: T0 + i * 1_000 }));
  const t = externalWorld(entries, srv);
  await loadExternal(t);
  const looked = t.httpCalls.filter((u) => u.startsWith('./claude/runs?')).map((u) => Number(new URL(u, 'http://x/').searchParams.get('since')));
  assert.deepEqual(looked.sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9].map((i) => T0 + i * 1_000));
  // Long-started runs with no match are not asked about again.
  await t.claudeTick();
  assert.equal(t.httpCalls.length, looked.length);
  t.stopClaudeFeed();
});

test('two concurrent external runs each get their own transcript', async () => {
  const srv = claudeServer({
    runs: [
      { id: RUN_A, cwd: '/work/project', startedAt: T0 + 1_000, prompt: 'Review the parser module' },
      { id: RUN_B, cwd: '/work/project', startedAt: T0 + 3_000, prompt: 'Write the release notes draft' },
    ],
    feeds: { [RUN_A]: [{ k: 'text', text: 'parser work' }], [RUN_B]: [{ k: 'text', text: 'notes work' }] },
  });
  // Both started within a few seconds; the second's label names its own prompt.
  const t = externalWorld([extEntry(), extEntry({ id: 'ext-2', label: 'Write the release notes draft', createdAt: T0 + 2_500, name: 'agent-2' })], srv);
  await openExternal(t);
  const panels = allByClass(t.card('s1'), 'run-claude');
  assert.deepEqual(panels.map((p) => textOf(p)), ['“parser work', '“notes work']);
  assert.notEqual(t.claudeRuns.get('s1\u0000ext-1').runId, t.claudeRuns.get('s1\u0000ext-2').runId);
  t.stopClaudeFeed();
});

test('a start time is read from the raw catalog when the list row lacks it', async () => {
  const srv = claudeServer({ runs: [{ id: RUN_A, cwd: '/work/project', startedAt: T0 + 1_000, prompt: 'x' }], feeds: { [RUN_A]: [{ k: 'tool', id: 'a', text: 'Grep: foo in server' }] } });
  const bare = extEntry();
  delete bare.createdAt;
  const t = externalWorld([bare], srv);
  t.onMux({ type: 'session/projection', sessionId: 's1', key: 'subagentCatalog', value: [{ id: 'ext-1', mode: 'external', label: 'Review the parser module', createdAt: new Date(T0).toISOString() }], seq: 30 }, {});
  await openExternal(t);
  assert.deepEqual(feedLines(t.card('s1')), ['›Grep: foo in server']);
  t.stopClaudeFeed();
});

test('a run id the server forgot is looked up again', async () => {
  const srv = claudeServer({ runs: [{ id: RUN_A, cwd: '/work/project', startedAt: T0, prompt: 'x' }], feeds: { [RUN_A]: [{ k: 'text', text: 'one' }] } });
  const t = externalWorld([extEntry()], srv);
  await openExternal(t);
  // dsh-rc restarted: the old id is unknown and the same transcript has a new one.
  srv.feeds = { [RUN_B]: [{ k: 'text', text: 'one' }, { k: 'text', text: 'two' }] };
  srv.runs = [{ id: RUN_B, cwd: '/work/project', startedAt: T0, prompt: 'x' }];
  await t.claudeTick();
  await t.claudeTick();
  assert.equal(t.claudeRuns.get('s1\u0000ext-1').runId, RUN_B);
  assert.deepEqual(feedLines(t.card('s1')), ['“one', '“two']);
  t.stopClaudeFeed();
});
