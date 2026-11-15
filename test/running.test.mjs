import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as prices from '../public/prices.js';
import * as actions from '../public/session-actions.js';
import * as review from '../public/review.js';

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
// Jobs, subagents and the card itself draw the shell's universal status glyph: `glyph`, one
// state class, and the role class the layout hooks on (run-dot, jdot, adot).
const GLYPH_STATES = ['idle', 'run', 'approve', 'ask', 'unread', 'done', 'failed', 'stopping', 'stopped'];
function glyphOf(el) {
  assert.ok(el, 'a glyph element');
  const cls = String(el.className || '').split(/\s+/);
  assert.ok(cls.includes('glyph'), `a status glyph, not ${el.className}`);
  assert.equal(el.getAttribute('aria-hidden'), 'true', 'the glyph is decoration; the row says the state');
  return cls.filter((c) => GLYPH_STATES.includes(c)).join(' ');
}
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
    dshReview: review,
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
  const epilogue = '\n;globalThis.__t = { S, renderDashboard, renderList, sessRow, scheduleDashboard, onMux, onHost, loadSessions, fmtElapsed, fmtClock, dateGroup, openSearch, closeSearch, activeSessions, liveJobs, toggleDashCard, jobRow, handleJobOutput, mergeJob, watchDashJobs, post, claudeTick, claudeRuns, get claudeFeed() { return claudeFeed; }, get claudeTimer() { return claudeTimer; }, stopClaudeFeed, get dsh2() { return dsh2; }, setDsh2(v) { dsh2 = v; } };';
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

test('the live row clock reads like a timer, never like a log line', () => {
  const t = harness();
  assert.equal(t.fmtClock(0), '0:00');
  assert.equal(t.fmtClock(7_400), '0:07');
  assert.equal(t.fmtClock(252_000), '4:12');
  assert.equal(t.fmtClock(3_852_000), '1:04:12');
  assert.equal(t.fmtClock(90_000_000), '25:00:00', 'hours keep counting; the clock never truncates to days');
  assert.equal(t.fmtClock(-5), '0:00');
  assert.equal(t.fmtClock(NaN), '0:00');
});

test('with nothing running the section stays out of the way', () => {
  const t = harness();
  t.renderDashboard();
  assert.equal(t.el('#running').hidden, true);
});

test('a live row shows title, clock, the current todo and todo progress, and no context below 80%', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  assert.equal(t.el('#running').hidden, false);
  assert.equal(t.el('#runningCount').textContent, '1');
  const row = t.card('s1');
  assert.ok(row, 'a live row for the running session');
  assert.match(String(row.className), /\brun-row\b/);
  assert.match(textOf(oneByClass(row, 'run-name')), /Fix the bug/);
  // 1 of 3 todos done, as words beside the 4px bar.
  assert.deepEqual(allByClass(row, 'run-meter').map((m) => textOf(m)), ['1 of 3']);
  assert.equal(textOf(oneByClass(row, 'run-current')), 'Patch the parser');
  // 25K of 100K context is not worth a chip: there is no permanent context meter.
  assert.equal(oneByClass(row, 'run-ctx'), undefined);
  assert.doesNotMatch(textOf(row), /ctx/);
  // The elapsed origin is the last human prompt from the list baseline, drawn as a clock.
  const elapsed = oneByClass(row, 'run-elapsed');
  assert.equal(elapsed.getAttribute('data-since'), String(PROMPT_AT));
  assert.match(textOf(elapsed), /^\d+:\d\d(:\d\d)?$/);
  // Nothing to expand, so no footer: a row with no jobs or subagents is shorter.
  assert.equal(oneByClass(row, 'run-more'), undefined);
});

test('context shows as a chip only from 80%, a warning from 85% and danger from 95%', async () => {
  const at = (pct) => ({ pressureTokens: pct * 1000, projectedTokens: pct * 1000, contextWindow: 100_000 });
  const rows = [79, 82, 86, 96].map((pct, i) => summary({ sessionId: 'c' + pct, updatedAt: T0 + i,
    projections: { asOfSeq: 1, values: { title: 'ctx ' + pct, contextPressure: at(pct), sessionListMetadata: { blank: false, lastPromptAt: PROMPT_AT } } } }));
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: rows } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  const chip = (pct) => oneByClass(t.card('c' + pct), 'run-ctx');
  assert.equal(chip(79), undefined);
  assert.equal(textOf(chip(82)), 'Context 82%');
  assert.equal(String(chip(82).className), 'run-ctx');
  assert.equal(String(chip(86).className), 'run-ctx warn');
  assert.equal(String(chip(96).className), 'run-ctx danger');
  // The word carries the level too: it is never colour alone.
  assert.equal(textOf(chip(96)), 'Context 96%');
});

test('Running now is one section of live rows with a count, not a fold over cards', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  assert.equal(t.el('#running').hidden, false, 'an active session shows the section');
  assert.equal(isLive(t.el('#runningCards')), false, 'the live rows always show');
  assert.equal(t.el('#runningHead').onclick, undefined, 'the header is a label, not a toggle');
  assert.equal(t.el('#runningHead').getAttribute('aria-expanded'), undefined);
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<h2 id="runningHead" class="sec-head">/);
  assert.match(html, /<ul id="runningCards" class="run-rows">/);
});

test('the current line falls back to the running job, then a live subagent, then the turn itself', async () => {
  const bare = (id) => summary({ sessionId: id, projections: { asOfSeq: 1, values: { title: id, sessionListMetadata: { blank: false, lastPromptAt: PROMPT_AT } } } });
  const t = harness({
    respond: (m, body) => {
      if (m === 'session.list') return { items: [bare('job'), bare('agent'), bare('turn')] };
      if (m === 'subagent.list') return { entries: body.payload.parentSessionId === 'agent' ? [childEntry()] : [], parentAvailable: true };
      return undefined;
    },
  });
  t.onMux(jobsFrame('job', [runningJob({ label: 'npm run dev' })]), {});
  await t.loadSessions();
  await settle();
  t.renderDashboard();
  const current = (id) => oneByClass(t.card(id), 'run-current');
  assert.equal(textOf(current('job')), 'npm run dev');
  assert.match(String(current('job').className), /mono-line/, 'a command reads in the mono face');
  assert.equal(textOf(current('agent')), 'Subagent: Run the tests');
  assert.equal(textOf(current('turn')), 'Working');
});

test('without a turn the clock counts from the oldest live job', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary({ running: false })] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  t.onMux(jobsFrame('s1', [runningJob({ id: 'j1', startedAt: T0 - 5_000 }), runningJob({ id: 'j2', startedAt: T0 - 90_000 })]), {});
  await t.loadSessions();
  t.renderDashboard();
  assert.equal(oneByClass(t.card('s1'), 'run-elapsed').getAttribute('data-since'), String(T0 - 90_000));
});

test('a session/jobs frame fills the job list', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [summary()] } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
  await t.loadSessions();
  t.onMux(jobsFrame('s1', [runningJob()]), {});
  t.renderDashboard();
  const card = t.card('s1');
  assert.equal(textOf(oneByClass(card, 'run-more-txt')), '1 job');
  // The footer and the title are separate hit areas: one expands, the other opens.
  assert.notEqual(oneByClass(card, 'run-more'), oneByClass(card, 'run-top'));
  assert.equal(oneByClass(card, 'run-more').getAttribute('aria-expanded'), 'false');
  // Expanded card shows the job rows; the row is complete enough to place the work.
  t.toggleDashCard('s1');
  const job = oneByClass(t.card('s1'), 'run-job');
  assert.equal(textOf(oneByClass(job, 'jkind')), 'bash');
  assert.equal(textOf(oneByClass(job, 'jlabel')), 'sleep 180');
  assert.equal(textOf(oneByClass(job, 'jstate')), 'running');
  assert.equal(oneByClass(job, 'jtime').getAttribute('data-since'), String(T0 - 5_000));
  assert.equal(glyphOf(oneByClass(job, 'jdot')), 'run');
});

test('a job row draws its state with the universal glyph: stopping and stopped stay apart', () => {
  const t = harness();
  const glyphFor = (status) => glyphOf(oneByClass(t.jobRow(runningJob({ id: 'j-' + status, status }), 's1'), 'jdot'));
  assert.equal(glyphFor('running'), 'run');
  assert.equal(glyphFor('completed'), 'done');
  assert.equal(glyphFor('failed'), 'failed');
  assert.equal(glyphFor('stopping'), 'stopping');
  assert.equal(glyphFor('killed'), 'stopped');
  assert.equal(glyphFor('something-new'), 'idle', 'an unknown state reads as idle, not as a failure');
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
  // The spinner stays: the turn is over, but the job is still working.
  assert.equal(glyphOf(oneByClass(t.card('s1'), 'run-dot')), 'run');
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
  assert.equal(textOf(oneByClass(row, 'astate')), 'running');
  assert.equal(glyphOf(oneByClass(row, 'adot')), 'run');
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
  assert.equal(glyphOf(oneByClass(row, 'adot')), 'done');
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
  assert.equal(glyphOf(oneByClass(row, 'adot')), 'run');
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
  assert.match(textOf(elapsed), /^1:\d\d$/);
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
  assert.deepEqual(allByClass(t.card('s1'), 'run-meter').map((m) => textOf(m)), ['1 of 1']);
  // A title arriving later redraws the row too.
  const titled = t.card('s1');
  t.onMux({ type: 'session/projection', sessionId: 's1', key: 'title', value: 'A better title', seq: 13 }, {});
  t.renderDashboard();
  assert.notEqual(t.card('s1'), titled);
  assert.equal(textOf(oneByClass(t.card('s1'), 'run-name')), 'A better title');
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
  assert.equal(textOf(stop), 'Stop');
  await stop.onclick();
  assert.equal(stop.textContent, 'Sure?');
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
  return glyphOf(oneByClass(row, 'adot'));
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

test('a folded row drops the panel and reads only at the slower pace, and an open chat stops the feed', async () => {
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
  assert.equal(extDot(t, 'Second opinion'), 'done');
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
  assert.equal(extDot(t, 'Review the parser module'), 'run', 'the transcript, not the inactive catalog row, decides the dot');
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
  assert.equal(extDot(t, 'Review the parser module'), 'run');
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
  assert.equal(glyphOf(oneByClass(t.card('s1'), 'run-dot')), 'run', 'the parent turn is over, but its transcript is still working');

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

// --- the board: Needs you, Running now, Unread, Today, Earlier -------------------------------

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
// Every data-session in a subtree, in document order.
function sessionIds(root) {
  const out = [];
  const walk = (n) => {
    if (!n || n.nodeType !== 1) return;
    const id = n.getAttribute && n.getAttribute('data-session');
    if (id) out.push(id);
    for (const k of n.childNodes || []) walk(k);
  };
  walk(root);
  return out;
}
const visible = (el) => !(el.hidden === true || el.hidden === '');
// The board as the user reads it: each visible region's sessions, top to bottom.
function board(t) {
  const regions = { needs: '#pendingGlobal', running: '#runningCards', rest: '#sessions' };
  const out = {};
  for (const [k, sel] of Object.entries(regions)) {
    const el = t.el(sel);
    const shown = k === 'running' ? visible(t.el('#running')) : k === 'needs' ? visible(el) : true;
    out[k] = shown ? sessionIds(el) : [];
  }
  return out;
}
const headings = (el) => allByClass(el, 'sec-head').map((x) => textOf(oneByClass(x, 'sec-label')));
// Local midnight, for rows that must land in a given date section whenever the test runs.
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const idleRow = (id, updatedAt, title = id) => ({ sessionId: id, updatedAt, running: false, blank: false, cwd: '/work/' + id,
  projections: { asOfSeq: 1, values: { title } } });
const approvalFrame = (sessionId, over = {}) => ({ type: 'approval/requested', sessionId, approvalId: 'ap-' + sessionId, toolName: 'bash', callId: 'call-' + sessionId, reason: 'This command is not on the allow list.', ...over });
const questionFrame = (sessionId, questions) => ({ type: 'question/requested', sessionId, questions });

function boardWorld(items) {
  return harness({ respond: (m) => (m === 'session.list' ? { items } : m === 'subagent.list' ? { entries: [], parentAvailable: true } : undefined) });
}

test('the board reads Needs you, Running now, Unread, Today, Earlier, top to bottom', async () => {
  // The fixed regions sit in this order in the page, with the large title above them all.
  const at = (id) => HTML.indexOf(`id="${id}"`);
  assert.ok(at('listLargeTitle') < at('pendingGlobal'), 'the large title leads');
  assert.ok(at('pendingGlobal') < at('running'), 'Needs you comes before Running now');
  assert.ok(at('running') < at('sessions'), 'Running now comes before the rest');

  const now = Date.now();
  const t = boardWorld([
    summary({ sessionId: 'run' }),
    idleRow('ask', now - 1_000),
    idleRow('fresh', now - 2_000),
    idleRow('today', now - 3_000),
    idleRow('yday', midnight() - 3_600_000),
    idleRow('week', midnight() - 3 * 86_400_000),
    idleRow('old', midnight() - 40 * 86_400_000),
  ]);
  await t.loadSessions();
  // `fresh` changes after this device last looked: it is unread.
  t.S.sessions.find((s) => s.sessionId === 'fresh').updatedAt = now + 60_000;
  t.onMux(questionFrame('ask', [{ id: 'q1', question: 'Which branch should I use?\nmain or next', options: [] }]), { rpcId: 'q-rpc' });
  t.renderDashboard();

  const b = board(t);
  assert.deepEqual(b.needs, ['ask']);
  assert.deepEqual(b.running, ['run']);
  assert.deepEqual(b.rest, ['fresh', 'today', 'yday', 'week', 'old']);
  assert.deepEqual(headings(t.el('#pendingGlobal')), ['Needs you']);
  assert.equal(textOf(oneByClass(t.el('#pendingGlobal'), 'sec-count')), '1');
  assert.deepEqual(headings(t.el('#sessions')), ['Unread', 'Today', 'Earlier']);
  assert.deepEqual(allByClass(t.el('#sessions'), 'sec-sub').map(textOf), ['Yesterday', 'Previous 7 days', 'Older']);
  // An unread row carries the filled accent dot.
  const fresh = allByClass(t.el('#sessions'), 'sess').find((r) => r.getAttribute('data-session') === 'fresh');
  assert.equal(glyphOf(oneByClass(fresh, 'glyph')), 'unread');
});

test('date sections follow the calendar day', () => {
  const t = harness();
  const now = new Date(2026, 0, 15, 9, 30).getTime();
  const day = (d, h = 12) => new Date(2026, 0, d, h).getTime();
  assert.equal(t.dateGroup(day(15, 0), now), 'today');
  assert.equal(t.dateGroup(day(14, 23), now), 'yesterday');
  assert.equal(t.dateGroup(day(14, 0), now), 'yesterday');
  assert.equal(t.dateGroup(day(9), now), 'week');
  assert.equal(t.dateGroup(day(7), now), 'older');
  assert.equal(t.dateGroup(undefined, now), 'older');
});

test('a session that is both waiting and running appears once, in Needs you', async () => {
  const t = boardWorld([summary({ sessionId: 's1' }), idleRow('idle', Date.now() - 5_000)]);
  await t.loadSessions();
  assert.deepEqual(board(t), { needs: [], running: ['s1'], rest: ['idle'] });

  t.onMux(approvalFrame('s1'), { rpcId: 'ap-rpc' });
  t.renderDashboard();
  assert.equal(t.S.running.get('s1'), true, 'the turn is still running');
  assert.deepEqual(board(t), { needs: ['s1'], running: [], rest: ['idle'] });
  assert.equal(t.el('#running').hidden, true, 'Running now hides when its only session is waiting');

  // Answered elsewhere: the session goes back to Running now, still exactly once.
  t.onMux({ type: 'approval/resolved', approvalId: 'ap-s1' }, {});
  t.renderDashboard();
  assert.deepEqual(board(t), { needs: [], running: ['s1'], rest: ['idle'] });
  assert.equal(t.el('#pendingGlobal').hidden, true, 'Needs you shows only when something waits');
});

test('a session that starts or stops working moves between Running now and its date section', async () => {
  const t = boardWorld([idleRow('a', Date.now() - 5_000), idleRow('b', Date.now() - 6_000)]);
  await t.loadSessions();
  assert.deepEqual(board(t), { needs: [], running: [], rest: ['a', 'b'] });
  // A live background job alone makes a session active: it leaves Today for Running now.
  t.onMux(jobsFrame('b', [runningJob()]), {});
  t.renderDashboard();
  assert.deepEqual(board(t), { needs: [], running: ['b'], rest: ['a'] });
  t.onMux(jobsFrame('b', []), {});
  t.renderDashboard();
  assert.deepEqual(board(t), { needs: [], running: [], rest: ['a', 'b'] });
});

test('every session appears exactly once across the board', async () => {
  const now = Date.now();
  const items = [summary({ sessionId: 'r1' }), summary({ sessionId: 'r2' }), summary({ sessionId: 'w1' }),
    idleRow('w2', now - 1_000), idleRow('u1', now - 2_000), idleRow('d1', now - 3_000), idleRow('d2', midnight() - 9 * 86_400_000)];
  const t = boardWorld(items);
  await t.loadSessions();
  t.S.sessions.find((s) => s.sessionId === 'u1').updatedAt = now + 60_000;
  t.onMux(approvalFrame('w1'), { rpcId: 'r-w1' });
  t.onMux(questionFrame('w2', [{ id: 'q', question: 'Ship it?', options: [] }]), { rpcId: 'r-w2' });
  t.renderDashboard();
  const b = board(t);
  const seen = [...b.needs, ...b.running, ...b.rest];
  assert.deepEqual(seen.slice().sort(), items.map((s) => s.sessionId).sort(), 'every session is somewhere');
  assert.equal(new Set(seen).size, seen.length, `no session twice: ${seen.join(', ')}`);
  assert.deepEqual(b.needs, ['w1', 'w2']);
  assert.deepEqual(b.running.slice().sort(), ['r1', 'r2']);
});

test('a Needs you row says what is asked in one line and opens the session, with no Allow or Deny', async () => {
  const t = boardWorld([idleRow('plain', Date.now() - 1_000, 'Plain approval'), idleRow('known', Date.now() - 2_000, 'Known command'),
    idleRow('plan', Date.now() - 3_000, 'Plan review'), idleRow('ask', Date.now() - 4_000, 'A question')]);
  await t.loadSessions();
  t.onMux(approvalFrame('plain'), { rpcId: 'r1' });
  t.onMux(approvalFrame('known', { args: JSON.stringify({ command: 'npm run build && npm test\necho done' }) }), { rpcId: 'r2' });
  t.onMux(questionFrame('plan', [{ id: 'plan-review', header: 'Plan', question: 'Approve this plan?', detail: '# Plan', options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Approve' } }]), { rpcId: 'r3' });
  t.onMux(questionFrame('ask', [{ id: 'q', question: '\nWhich database should the tests use?\nPick one.', options: [] }]), { rpcId: 'r4' });
  const rows = allByClass(t.el('#pendingGlobal'), 'sess');
  const ask = (id) => textOf(oneByClass(rows.find((r) => r.getAttribute('data-session') === id), 'ask-sum'));
  assert.equal(ask('plain'), 'Allow Bash? This command is not on the allow list.');
  assert.equal(ask('known'), 'Allow Bash: npm run build && npm test');
  assert.equal(ask('ask'), 'Which database should the tests use?');
  assert.equal(ask('plan'), 'Approve the plan');
  const glyph = (id) => glyphOf(oneByClass(rows.find((r) => r.getAttribute('data-session') === id), 'glyph'));
  assert.equal(glyph('plain'), 'approve');
  assert.equal(glyph('ask'), 'ask', 'a question keeps its own glyph');
  for (const r of rows) {
    const buttons = [];
    const walk = (n) => { if (n && n.nodeType === 1) { if (n.tagName === 'BUTTON') buttons.push(n); (n.childNodes || []).forEach(walk); } };
    walk(r);
    assert.equal(buttons.length, 1, 'the whole row is one button');
    assert.doesNotMatch(textOf(r), /\b(Deny|Allow once)\b/);
    assert.equal(String(buttons[0].className), 'sess-hit');
  }
});

test('a failed session stays in its date section with "Failed", not in Needs you', async () => {
  const t = boardWorld([idleRow('f1', Date.now() - 5_000, 'Broke the build')]);
  await t.loadSessions();
  t.onHost({ type: 'host/agent-error', sessionId: 'f1', message: 'boom' });
  assert.deepEqual(board(t), { needs: [], running: [], rest: ['f1'] });
  const row = oneByClass(t.el('#sessions'), 'sess');
  assert.equal(textOf(oneByClass(row, 'failed-word')), 'Failed');
  assert.equal(glyphOf(oneByClass(row, 'glyph')), 'failed');
});

test('an empty board says so once the list is in, with one sentence and no filter wording', async () => {
  const t = boardWorld([]);
  t.renderList();
  assert.equal(oneByClass(t.el('#sessions'), 'empty-state'), undefined, 'nothing is claimed empty before the first answer');
  await t.loadSessions();
  const empty = oneByClass(t.el('#sessions'), 'empty-state');
  assert.ok(empty, 'an empty state');
  assert.equal(textOf(oneByClass(empty, 'empty-title')), 'No sessions yet');
  assert.equal(textOf(oneByClass(empty, 'empty-body')), 'Start one from your laptop, or tap New session.');
  assert.ok(oneByClass(empty, 'empty-glyph'));
  assert.equal(t.el('#running').hidden, true);
  assert.equal(t.el('#pendingGlobal').hidden, true);
  assert.equal(t.el('#moreBtn').hidden, true);
  assert.doesNotMatch(APP, /Nothing is running|Nothing is waiting for you|Nothing unread|filterSheet|filteredSessions|S\.filter\b/);
});

test('the date sections page by forty and the quiet button loads the next page', async () => {
  const now = Date.now();
  const items = Array.from({ length: 45 }, (_, i) => idleRow('p' + i, now - i * 1_000));
  const t = boardWorld(items);
  await t.loadSessions();
  assert.equal(sessionIds(t.el('#sessions')).length, 40);
  assert.equal(t.el('#moreBtn').hidden, false);
  t.el('#moreBtn').onclick();
  assert.equal(sessionIds(t.el('#sessions')).length, 45);
  assert.equal(t.el('#moreBtn').hidden, true);
});

test('search takes the board\'s place and Cancel puts it back where it was', async () => {
  const t = boardWorld([idleRow('a', Date.now() - 1_000, 'Alpha')]);
  await t.loadSessions();
  t.el('#listScroll').scrollTop = 420;
  t.openSearch();
  assert.equal(t.S.searchMode, true);
  assert.equal(t.el('#searchRow').hidden, false);
  assert.equal(t.el('#searchResults').hidden, false);
  assert.equal(t.el('#searchBtn').getAttribute('aria-expanded'), 'true');
  assert.equal(t.el('#listScroll').scrollTop, 0, 'results start at the top');
  // While searching, live updates leave the hidden board alone.
  t.onMux(approvalFrame('a'), { rpcId: 'r' });
  t.closeSearch();
  assert.equal(t.S.searchMode, false);
  assert.equal(t.el('#searchRow').hidden, true);
  assert.equal(t.el('#searchResults').hidden, true);
  assert.equal(t.el('#listScroll').scrollTop, 420, 'Cancel restores the scroll position');
  assert.deepEqual(board(t).needs, ['a'], 'and the board is current again');
  assert.doesNotMatch(HTML, /id="filterBtn"|filterSheet/);
  assert.match(HTML, /<header class="nav" id="listNav">[\s\S]*id="searchBtn"[\s\S]*id="searchRow"[\s\S]*<\/header>/, 'search lives in the nav');
});

test('an approval row finds the command in the session history', async () => {
  const t = harness({
    respond: (m) => {
      if (m === 'session.list') return { items: [idleRow('s1', Date.now() - 1_000, 'Build the parser')] };
      if (m === 'session.history') return { events: [{
        event: { seq: 1, time: T0, type: 'tool/call', data: {
          callId: 'call-build', name: 'bash', arguments: JSON.stringify({ command: 'npm run build && npm test\necho done' }),
        } },
      }] };
      return undefined;
    },
  });
  await t.loadSessions();
  t.onMux(approvalFrame('s1', { callId: 'call-build' }), { rpcId: 'ap-rpc' });
  await settle();
  const row = oneByClass(t.el('#pendingGlobal'), 'sess');
  assert.equal(textOf(oneByClass(row, 'ask-sum')), 'Allow Bash: npm run build && npm test');
  assert.equal(t.S.approvals.get('ap-s1').args.includes('npm run build'), true, 'the argument is cached on the frame');
});

test('a search hit that is only the title does not repeat it as a snippet', async () => {
  const t = harness({ respond: (m) => (m === 'session.list' ? { items: [idleRow('s1', Date.now() - 1_000, 'Fix the bug')] } : undefined) });
  await t.loadSessions();
  t.S.titles.set('s1', 'Fix the bug');
  const same = t.sessRow({ sessionId: 's1', cwd: '/work/demo', updatedAt: Date.now() - 60_000 }, 'Fix the bug');
  assert.equal(oneByClass(same, 'snip'), undefined);
  assert.match(textOf(oneByClass(same, 'm')), /demo/);
  const distinct = t.sessRow({ sessionId: 's1', cwd: '/work/demo', updatedAt: Date.now() - 60_000 }, 'The handler computes end as start + limit.');
  assert.match(textOf(oneByClass(distinct, 'snip')), /handler/);
});

test('a failed unread row keeps the unread dot and writes Failed in red', async () => {
  const t = boardWorld([idleRow('f1', Date.now() - 5_000, 'Broke the build')]);
  await t.loadSessions();
  t.onHost({ type: 'host/agent-error', sessionId: 'f1', message: 'boom' });
  t.S.sessions.find((s) => s.sessionId === 'f1').updatedAt = Date.now() + 60_000;
  t.renderList();
  const row = oneByClass(t.el('#sessions'), 'sess');
  assert.equal(glyphOf(oneByClass(row, 'glyph')), 'unread');
  assert.equal(textOf(oneByClass(row, 'failed-word')), 'Failed');
  assert.ok(String(row.className).includes('unread'));
});

test('a live subagent is a clock even when no turn or job is running', async () => {
  const t = harness({
    respond: (m, body) => {
      if (m === 'session.list') return { items: [summary({ sessionId: 's1', running: false,
        projections: { asOfSeq: 1, values: { title: 'Sub work', sessionListMetadata: { blank: false, lastPromptAt: PROMPT_AT } } } })] };
      if (m === 'subagent.list') return { entries: body.payload.parentSessionId === 's1' ? [childEntry()] : [], parentAvailable: true };
      return undefined;
    },
  });
  t.onMux({ type: 'session/projection', sessionId: 'sub-1', key: 'subagentTiming', value: { settledMs: 0, active: { since: PROMPT_AT, through: T0 } }, seq: 2 }, {});
  await t.loadSessions();
  await settle();
  // The catalog is a projection push in dsh; seed the tree the push would have loaded.
  t.S.subagents.set('s1', { entries: [childEntry()], parentAvailable: true, at: Date.now() });
  t.renderDashboard();
  const row = t.card('s1');
  assert.ok(row, 'the subagent alone keeps a live row');
  assert.equal(oneByClass(row, 'run-elapsed').getAttribute('data-since'), String(PROMPT_AT));
  assert.equal(textOf(oneByClass(row, 'run-current')), 'Subagent: Run the tests');
});
