import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as review from '../public/review.js';
import * as prices from '../public/prices.js';
import { mapFrame } from '../server/notify.mjs';

const { diffLines, diffStats, foldContext, diffsOf, summarizeTurn, planReviewOf, planAnswer } = review;
const ops = (d) => d.map((o) => (o.op === 'skip' ? `…${o.count}` : o.op + o.text)).join('|');

// --- Shapes dsh sends --------------------------------------------------------
// dsh-plan-mode's exit_plan_mode asks exactly this question.
const PLAN_QUESTION = {
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: '# Add a cache\n\n1. Read the config\n2. Wire it in',
  options: [
    { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
    { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
  ],
  intent: { kind: 'plan-review', approve: 'Approve' },
};
// dsh-tools' write/edit views: the call side from the arguments, the result
// side the applied hunk.
const editCall = (path, oldText, newText) => ({ for: 'call', view: { card: 'diff', title: 'Edit ' + path, diffs: [{ path, oldText, newText }] } });
const editResult = (path, oldText, newText) => ({ for: 'result', view: { card: 'diff', diffs: [{ path, oldText, newText }] } });
const bashCall = (command) => ({ for: 'call', view: { card: 'terminal', title: command } });
const bashResult = (exitCode, output = '') => ({ for: 'result', view: { card: 'terminal', output, exitCode } });

// --- diffLines ---------------------------------------------------------------

test('diffLines aligns a changed line between unchanged ones', () => {
  assert.equal(ops(diffLines('a\nb\nc\n', 'a\nB\nc\n')), ' a|-b|+B| c');
});

test('diffLines keeps a moved-past common line as context', () => {
  assert.equal(ops(diffLines('x\ny\nz', 'y\nz\nw')), '-x| y| z|+w');
});

test('diffLines treats a null before-image as a created file', () => {
  const d = diffLines(null, 'one\ntwo\n');
  assert.equal(ops(d), '+one|+two');
  assert.deepEqual(diffStats(d), { adds: 2, dels: 0 });
});

test('diffLines of equal texts is all context', () => {
  assert.deepEqual(diffStats(diffLines('a\nb', 'a\nb')), { adds: 0, dels: 0 });
});

test('diffLines falls back to remove-then-add past the size cap without hanging', () => {
  const a = Array.from({ length: 1200 }, (_, i) => 'a' + i).join('\n');
  const b = Array.from({ length: 1200 }, (_, i) => 'b' + i).join('\n');
  const d = diffLines(a, b);
  assert.deepEqual(diffStats(d), { adds: 1200, dels: 1200 });
  assert.equal(d[0].op, '-');
});

test('foldContext keeps three lines around a change and folds the rest', () => {
  const before = Array.from({ length: 20 }, (_, i) => 'l' + i).join('\n');
  const after = before.replace('l10', 'L10');
  const folded = foldContext(diffLines(before, after));
  assert.equal(ops(folded), '…7| l7| l8| l9|-l10|+L10| l11| l12| l13|…6');
});

test('foldContext leaves a short run alone', () => {
  assert.equal(ops(foldContext(diffLines('a\nb\nc', 'a\nB\nc'))), ' a|-b|+B| c');
});

// --- diffsOf -----------------------------------------------------------------

test('diffsOf: the call view while running, the result view once settled', () => {
  const t = { view: editCall('f.js', 'a', 'b').view };
  assert.equal(diffsOf(t)[0].newText, 'b');
  t.done = true; t.rview = editResult('f.js', 'x\na', 'x\nc').view;
  assert.equal(diffsOf(t)[0].newText, 'x\nc');
});

test('diffsOf: a settled call with a generic result view stays generic (a failed edit)', () => {
  assert.equal(diffsOf({ done: true, view: editCall('f.js', 'a', 'b').view, rview: { card: 'generic' } }), null);
  assert.equal(diffsOf({ done: true, isError: true, view: editCall('f.js', 'a', 'b').view }), null);
  assert.equal(diffsOf({ done: true, view: { card: 'generic', title: 'Read' } }), null);
  assert.equal(diffsOf({ view: { card: 'diff-v2', diffs: [] } }), null);
});

// --- summarizeTurn -----------------------------------------------------------

const edit = (id, path, oldText, newText, extra = {}) => ({ id, done: true, view: editCall(path, oldText, newText).view, rview: editResult(path, oldText, newText).view, ...extra });
const bash = (id, command, exitCode) => ({ id, done: true, view: bashCall(command).view, rview: bashResult(exitCode).view });

test('summarizeTurn counts files, lines and commands, and passes on a clean finish', () => {
  const s = summarizeTurn([
    edit('c1', 'src/a.js', 'x\ny', 'x\nY\nz'),
    edit('c2', 'src/a.js', 'q', 'Q'),
    edit('c3', 'README.md', null, 'hi\n'),
    bash('c4', 'npm test', 0),
  ], { kind: 'completed' });
  assert.deepEqual(s.files.map((f) => [f.path, f.adds, f.dels, f.callIds.join()]), [['src/a.js', 3, 2, 'c1,c2'], ['README.md', 1, 0, 'c3']]);
  assert.equal(s.adds, 4); assert.equal(s.dels, 2);
  assert.deepEqual(s.commands.map((c) => [c.title, c.exitCode, c.failed]), [['npm test', 0, false]]);
  assert.equal(s.outcome, 'passed');
});

test('summarizeTurn: a failure fixed and rerun in the same turn still passes', () => {
  const s = summarizeTurn([bash('c1', 'npm test', 1), edit('c2', 'a.js', 'a', 'b'), bash('c3', 'npm test', 0)], { kind: 'completed' });
  assert.equal(s.failedCommands, 1);
  assert.equal(s.outcome, 'passed');
});

test('summarizeTurn fails when the last command fails or the turn errors', () => {
  const last = summarizeTurn([bash('c1', 'npm test', 2)], { kind: 'completed' });
  assert.equal(last.outcome, 'failed');
  assert.equal(last.why, 'the last command exited 2');
  const err = summarizeTurn([bash('c1', 'ls', 0)], { kind: 'error', error: { message: 'rate limited', code: 'X' } });
  assert.equal(err.outcome, 'failed');
  assert.equal(err.why, 'rate limited');
  const killed = summarizeTurn([{ id: 'k', done: true, view: bashCall('sleep 99').view, rview: { card: 'terminal', signal: 'SIGTERM' } }], { kind: 'completed' });
  assert.equal(killed.why, 'the last command was killed by SIGTERM');
});

test('summarizeTurn: an interrupted turn is stopped, and a failed edit changes no file', () => {
  const s = summarizeTurn([edit('c1', 'a.js', 'a', 'b', { isError: true, rview: { card: 'generic' } })], { kind: 'aborted', reason: { kind: 'user' } });
  assert.equal(s.files.length, 0);
  assert.equal(s.outcome, 'stopped');
});

// --- plan review -------------------------------------------------------------

test('planReviewOf narrows dsh plan mode\'s review question', () => {
  const r = planReviewOf([PLAN_QUESTION]);
  assert.equal(r.plan, PLAN_QUESTION.detail);
  assert.equal(r.approve.label, 'Approve');
  assert.equal(r.decline.label, 'Keep planning');
});

test('planReviewOf leaves anything else an ordinary question', () => {
  assert.equal(planReviewOf([{ id: 'q', question: 'Which?' }]), null);
  assert.equal(planReviewOf([PLAN_QUESTION, PLAN_QUESTION]), null);
  assert.equal(planReviewOf([{ ...PLAN_QUESTION, detail: undefined }]), null);
  assert.equal(planReviewOf([{ ...PLAN_QUESTION, intent: { kind: 'plan-review', approve: 'Ship it' } }]), null);
  assert.equal(planReviewOf([{ ...PLAN_QUESTION, multiSelect: true }]), null);
});

test('planAnswer: approve sends only the approve label; feedback rides with keep planning', () => {
  const r = planReviewOf([PLAN_QUESTION]);
  assert.deepEqual(planAnswer(r, true), { answers: [{ id: 'plan-review', selected: ['Approve'] }] });
  assert.deepEqual(planAnswer(r, false, '  '), { answers: [{ id: 'plan-review', selected: ['Keep planning'] }] });
  assert.deepEqual(planAnswer(r, false, 'use redis'), { answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'use redis' }] });
});

test('notify: a plan review is named as one, with the plan heading', () => {
  const n = mapFrame({ payload: { type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] } }, {});
  assert.equal(n.title, 'Plan ready for review');
  assert.equal(n.body, 'Add a cache');
  const q = mapFrame({ payload: { type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', question: 'Which?' }] } }, {});
  assert.equal(q.title, 'Question waiting');
});

// --- The shipped renderer ----------------------------------------------------
// The same approach as statusline.test.mjs: run the real app.js in a vm over a
// small DOM stub and read back what it built.

const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function stubEl(tag) {
  const el = {
    nodeType: 1, tagName: tag, hidden: false, open: false, value: '', textContent: '', className: '',
    childNodes: [], dataset: {}, disabled: false,
    style: { setProperty() {}, removeProperty() {} },
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) { el['on' + type] = fn; },
    removeEventListener() {},
    setAttribute(name, value) { el[name] = value; },
    getAttribute: (name) => el[name],
    removeAttribute() {},
    append(...kids) { el.childNodes.push(...kids); },
    appendChild(kid) { el.childNodes.push(kid); return kid; },
    replaceChildren(...kids) { el.childNodes = kids; },
    replaceWith() {}, remove() {}, focus() {}, click() {}, scrollIntoView() { el.scrolled = true; },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}
const textOf = (n) => (typeof n === 'string' ? n : n && n.childNodes ? n.childNodes.map(textOf).join('') : '');
function walk(n, out = []) {
  if (n && typeof n === 'object') { out.push(n); for (const k of n.childNodes || []) walk(k, out); }
  return out;
}
const find = (root, pred) => walk(root).filter((n) => n.nodeType === 1 && pred(n));
const byClass = (root, cls) => find(root, (n) => (' ' + n.className + ' ').includes(' ' + cls + ' '));
const buttonNamed = (root, label) => find(root, (n) => n.tagName === 'BUTTON' && textOf(n) === label)[0];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (o) => JSON.parse(JSON.stringify(o));

function harness(respond) {
  const els = new Map();
  const document = {
    visibilityState: 'visible',
    documentElement: { style: { setProperty() {} } },
    addEventListener() {},
    createElement: (tag) => stubEl(tag.toUpperCase()),
    querySelector(sel) { if (!els.has(sel)) els.set(sel, stubEl(sel)); return els.get(sel); },
    querySelectorAll: () => [],
  };
  const window = { dshPrices: prices, dshReview: review, addEventListener() {}, innerHeight: 800, matchMedia: () => ({ matches: false }), scrollTo() {} };
  const calls = [];
  const context = {
    window, document, navigator: {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { hash: '', protocol: 'http:', host: 'localhost', pathname: '/' },
    history: { pushState() {} },
    WebSocket: function WebSocketStub() { return { close() {}, send() {}, readyState: 1 }; },
    requestAnimationFrame: (cb) => { cb(); return 0; },
    cancelAnimationFrame() {},
    matchMedia: window.matchMedia,
    CSS: { escape: (s) => s },
    crypto: { randomUUID: () => 'rpc-' + calls.length },
    fetch: async (url, init) => {
      const method = String(url).replace(/^.*\/api\//, '');
      const body = init && init.body ? JSON.parse(init.body) : {};
      calls.push({ method, body });
      const value = respond ? respond(method, body) : undefined;
      if (value === undefined) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ result: { ok: true, value } }) };
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(APP + '\n;globalThis.__t = { S, R, onMux, openSession };', context, { filename: 'public/app.js' });
  const t = context.__t;
  t.calls = calls;
  t.el = (sel) => document.querySelector(sel);
  return t;
}

const ev = (seq, type, data, view) => ({ event: { seq, time: 1_700_000_000_000 + seq, type, data }, ...(view ? { view } : {}) });
const toolCall = (seq, callId, name, args, view) => ev(seq, 'tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }, view);
const toolResult = (seq, callId, text, view, isError = false) => ev(seq, 'tool/result', {
  turn: 1, step: 1,
  message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text }] }] },
}, view);

const TURN = [
  ev(1, 'turn/start', { turn: 1 }),
  toolCall(2, 'e1', 'edit', { path: 'src/a.js' }, editCall('/work/proj/src/a.js', 'one\ntwo\n', 'one\nTWO\n')),
  toolResult(3, 'e1', 'Edited', editResult('/work/proj/src/a.js', 'one\ntwo\n', 'one\nTWO\nthree\n')),
  toolCall(4, 'b1', 'bash', { command: 'npm test' }, bashCall('npm test')),
  toolResult(5, 'b1', 'fail', bashResult(1, 'fail')),
  toolCall(6, 'b2', 'bash', { command: 'npm test' }, bashCall('npm test')),
  toolResult(7, 'b2', 'ok', bashResult(0, 'ok')),
  ev(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
];

async function openWith(events) {
  const t = harness((method) => {
    if (method === 'session.history') return { events, hasMore: false };
    if (method === 'session.models') return { current: { provider: 'p', model: 'm' } };
    if (method === 'respond') return { accepted: true };
    return undefined;
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/proj' }];
  await t.openSession('s1');
  return t;
}

test('a finished turn ends with a summary card of files, commands and the verdict', async () => {
  const t = await openWith(TURN);
  const card = byClass(t.el('#msgs'), 'turncard')[0];
  assert.ok(card, 'summary card rendered');
  assert.match(card.className, /passed/);
  const text = textOf(card);
  assert.match(text, /1 file changed\+2 −1/);
  assert.match(text, /src\/a\.js\+2 −1/); // relative to the session folder
  assert.match(text, /2 commands run, 1 failed/);
  assert.match(text, /✗npm testexit 1✓npm testexit 0/);
  // Tapping a file opens its tool row.
  byClass(card, 'tc-row')[0].onclick();
  assert.equal(t.R.tools.get('e1').el.open, true);
  assert.equal(t.R.tools.get('e1').el.scrolled, true);
});

test('a turn that only talked gets no summary card', async () => {
  const t = await openWith([ev(1, 'turn/start', { turn: 1 }), ev(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })]);
  assert.equal(byClass(t.el('#msgs'), 'turncard').length, 0);
});

test('a turn whose start is outside the loaded window says so', async () => {
  const t = await openWith(TURN.slice(3));
  assert.match(textOf(byClass(t.el('#msgs'), 'turncard')[0]), /Earlier steps of this turn are not loaded/);
});

test('an edit row shows its line counts and draws the applied hunk as a diff', async () => {
  const t = await openWith(TURN);
  const row = t.R.tools.get('e1').el;
  assert.equal(textOf(byClass(row, 'delta')[0]), '+2 −1');
  row.open = true; row.ontoggle();
  const lines = byClass(row, 'dl').map((n) => textOf(n));
  assert.deepEqual(lines, [' one', '-two', '+TWO', '+three']);
  assert.equal(textOf(byClass(row, 'dpath')[0]), 'src/a.js');
});

test('a plan review renders as a plan card and answers with dsh\'s labels', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] }, { rpcId: 'q-1' });
  const card = byClass(t.el('#pending'), 'plan')[0];
  assert.ok(card, 'plan card rendered');
  assert.match(textOf(card), /Add a cache/);
  const fb = find(card, (n) => n.tagName === 'TEXTAREA')[0];
  fb.value = 'use redis';
  buttonNamed(card, 'Keep planning').onclick();
  await tick(); await tick();
  const sent = t.calls.find((c) => c.method === 'respond');
  assert.deepEqual(plain(sent.body), {
    type: 'client-response', rpcId: 'q-1',
    result: { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'use redis' }] } } },
  });
  assert.equal(t.S.questions.size, 0);
});

test('approving a plan sends the approve label alone, and a reply closes the review as cancelled', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] }, { rpcId: 'q-2' });
  buttonNamed(byClass(t.el('#pending'), 'plan')[0], 'Approve').onclick();
  await tick(); await tick();
  assert.deepEqual(plain(t.calls.filter((c) => c.method === 'respond')[0].body.result.value.answer), { answers: [{ id: 'plan-review', selected: ['Approve'] }] });

  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] }, { rpcId: 'q-3' });
  buttonNamed(byClass(t.el('#pending'), 'plan')[0], 'Reply instead').onclick();
  await tick(); await tick();
  const cancel = t.calls.filter((c) => c.method === 'respond')[1].body;
  assert.equal(cancel.rpcId, 'q-3');
  assert.equal(cancel.result.ok, false);
  assert.equal(cancel.result.error.code, 'cancelled');
});

test('an ordinary question still renders as a question card', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', question: 'Which branch?' }] }, { rpcId: 'q-4' });
  assert.equal(byClass(t.el('#pending'), 'plan').length, 0);
  assert.match(textOf(t.el('#pending')), /dsh is asking/);
});
