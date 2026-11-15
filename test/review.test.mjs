import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as review from '../public/review.js';
import * as prices from '../public/prices.js';
import * as dsh02 from '../public/dsh02.js';
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
    insertBefore(kid, ref) { const i = el.childNodes.indexOf(ref); el.childNodes.splice(i < 0 ? el.childNodes.length : i, 0, kid); return kid; },
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
  const window = { dshPrices: prices, dshReview: review, dsh02, addEventListener() {}, innerHeight: 800, matchMedia: () => ({ matches: false }), scrollTo() {} };
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
  vm.runInContext(APP + '\n;globalThis.__t = { S, R, onMux, openSession, revealTool, addCodeCopy, paintComposer, send, useDsh02: (c) => { dsh2 = c; } };', context, { filename: 'public/app.js' });
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
  assert.equal(card.open, false, 'passed receipts start collapsed');
  assert.match(textOf(card), /Edit.*Bash.*Bash/, 'receipt carries the turn activity rows');
  const text = textOf(card);
  assert.match(text, /1 file changed\+2 −1/);
  assert.match(text, /src\/a\.js\+2 −1/); // relative to the session folder
  assert.match(text, /2 commands run, 1 failed/);
  assert.match(text, /BashFailednpm testexit 1/);
  assert.match(text, /Bashnpm testexit 0/);
  // Opening a file's tool row also opens the receipt that contains it.
  t.revealTool('e1');
  assert.equal(card.open, true);
  assert.equal(t.R.tools.get('e1').el.open, true);
  assert.equal(t.R.tools.get('e1').el.scrolled, true);
});

const assistant = (seq, content) => ev(seq, 'assistant/message', { turn: 1, step: seq, message: { role: 'assistant', content } });
const prose = (text) => ({ type: 'text', text });

test('a tool turn separates the final answer from narration and keeps activity in its receipt', async () => {
  const events = [ev(1,'turn/start',{turn:1}), assistant(2,[prose('I will inspect this first.')]), toolCall(3,'e1','edit',{path:'src/a.js'},editCall('/work/proj/src/a.js','a','b')), toolResult(4,'e1','done',editResult('/work/proj/src/a.js','a','b')), assistant(5,[prose('The fix is complete.')]), ev(6,'turn/end',{turn:1,reason:{kind:'completed'}})];
  const t=await openWith(events), root=t.el('#msgs'), turn=byClass(root,'transcript-turn')[0], receipt=byClass(root,'turncard')[0];
  assert.ok(byClass(turn,'md')[0], 'answer markdown exists'); assert.match(byClass(turn,'md')[0].innerHTML,/The fix is complete/); assert.doesNotMatch(textOf(turn),/I will inspect/);
  assert.ok(receipt); assert.equal(receipt.open,false); assert.match(receipt.className,/passed/);
  receipt.open=true; assert.match(byClass(receipt,'act-text')[0].innerHTML,/I will inspect this first./); assert.ok(t.R.tools.get('e1').el);
  t.R.tools.get('e1').el.open=true; t.R.tools.get('e1').el.ontoggle(); assert.ok(byClass(t.R.tools.get('e1').el,'dl').length);
  t.R.tools.get('e1').el.open=false; t.R.tools.get('e1').el.ontoggle(); assert.equal(t.R.tools.get('e1').el.open,false);
});

test('a turn ending on a tool call uses its last preceding text as the answer', async () => {
  const t=await openWith([ev(1,'turn/start',{turn:1}),assistant(2,[prose('Answer before final action')]),toolCall(3,'b','bash',{command:'true'},bashCall('true')),toolResult(4,'b','',bashResult(0)),ev(5,'turn/end',{turn:1,reason:{kind:'completed'}})]);
  assert.match(byClass(t.el('#msgs'),'md')[0].innerHTML,/Answer before final action/);
});

test('a no-tool turn remains prose without a receipt', async () => {
  const t=await openWith([ev(1,'turn/start',{turn:1}),assistant(2,[prose('Just prose')]),ev(3,'turn/end',{turn:1,reason:{kind:'completed'}})]);
  assert.match(byClass(t.el('#msgs'),'md')[0].innerHTML,/Just prose/); assert.equal(byClass(t.el('#msgs'),'turncard').length,0);
});

test('live activity keeps the last three rows and discloses earlier rows', async () => {
  const t=await openWith([]); t.onMux({type:'session/event',event:ev(1,'turn/start',{turn:1}).event,sessionId:'s1'});
  for (let i=1;i<=5;i++) t.onMux({type:'session/event',sessionId:'s1',event:toolCall(i+1,'live'+i,'bash',{command:'step '+i},bashCall('step '+i)).event});
  const turn=byClass(t.el('#msgs'),'transcript-turn')[0];
  assert.equal(byClass(turn,'tool').length,3); assert.ok(buttonNamed(turn,'2 earlier steps'));
  buttonNamed(turn,'2 earlier steps').onclick(); assert.equal(byClass(turn,'tool').length,5);
  t.onMux({type:'session/event',sessionId:'s1',event:ev(7,'turn/end',{turn:1,reason:{kind:'aborted'}}).event});
});

test('an aborted turn keeps the text that had already streamed', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'session/event', sessionId: 's1', event: ev(1, 'turn/start', { turn: 1 }).event });
  t.onMux({ type: 'session/event', sessionId: 's1', event: ev(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'Half an answer' } }).event });
  t.onMux({ type: 'session/event', sessionId: 's1', event: ev(3, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }).event });
  assert.match(byClass(t.el('#msgs'), 'md')[0].innerHTML, /Half an answer/);
  assert.match(textOf(t.el('#msgs')), /Interrupted/);
});

test('history replay and live events produce the same turn grouping', async () => {
  const events=[ev(1,'turn/start',{turn:1}),assistant(2,[prose('Planning narration')]),toolCall(3,'x','bash',{command:'pwd'},bashCall('pwd')),toolResult(4,'x','/work',bashResult(0)),assistant(5,[prose('Final response')]),ev(6,'turn/end',{turn:1,reason:{kind:'completed'}})];
  const history=await openWith(events), live=await openWith([]);
  for (const f of events) live.onMux({...f,type:'session/event',sessionId:'s1'});
  const signature=(t)=>{
    const root=t.el('#msgs'), turns=byClass(root,'transcript-turn');
    return turns.map((turn)=>({answers:byClass(turn,'md').map((m)=>m.innerHTML),receipts:byClass(turn,'turncard').map((r)=>({meta:textOf(byClass(r,'receipt-meta')[0]),classes:r.className,activity:byClass(r,'receipt-activity').map((a)=>find(a,(n)=>n.className==='md').map((m)=>m.innerHTML).join('|')+';'+byClass(a,'tool').map((x)=>textOf(x)).join('|'))}))}));
  };
  assert.deepEqual(signature(live),signature(history));
});

test('a mid-turn history window marks missing earlier activity', async () => {
  const t=await openWith(TURN.slice(3)); assert.match(textOf(byClass(t.el('#msgs'),'turncard')[0]),/Earlier steps of this turn are not loaded/);
});

test('a failed turn opens its receipt and keeps the reason visible', async () => {
  const events = TURN.map((f) => f.event.type === 'turn/end'
    ? { ...f, event: { ...f.event, data: { ...f.event.data, reason: { kind: 'error', error: { message: 'demo failure' } } } } }
    : f);
  const t = await openWith(events);
  const card = byClass(t.el('#msgs'), 'turncard')[0];
  assert.notEqual(card.getAttribute('open'), null);
  assert.match(textOf(card), /Failed/);
  assert.match(textOf(card), /demo failure/);
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
  // The file header is the fold control: the diff is a details, open by default.
  const diff = byClass(row, 'diff')[0];
  assert.equal(diff.tagName, 'DETAILS');
  assert.equal(byClass(diff, 'dhead')[0].tagName, 'SUMMARY');
});

test('a rendered code block gets a Copy action without a new parser', () => {
  const t = harness();
  const parent = stubEl('div');
  const pre = stubEl('pre');
  pre.textContent = 'const x = 1';
  pre.parentNode = parent;
  parent.childNodes.push(pre);
  t.addCodeCopy({ querySelectorAll: (sel) => (sel === 'pre' ? [pre] : []) });
  const wrap = byClass(parent, 'codeblock')[0];
  assert.ok(wrap, 'the pre is wrapped in a codeblock');
  assert.equal(textOf(byClass(wrap, 'code-copy')[0]), 'Copy');
  assert.ok(wrap.childNodes.includes(pre));
});

// --- Decision cards (PR 5) ----------------------------------------------------

const sheetBody = (t) => t.el('#sheetBody');
const sheetFoot = (t) => t.el('#sheetFoot');
const responds = (t) => t.calls.filter((c) => c.method === 'respond');

test('a plan review is a compact card: the goal, the first two steps and Review plan', async () => {
  const t = await openWith([]);
  const detail = '# Add a cache\n\n1. Read the config\n2. Wire it in\n3. Add a test\n4. Ship it';
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [{ ...PLAN_QUESTION, detail }] }, { rpcId: 'q-1' });
  const card = byClass(t.el('#pending'), 'plan')[0];
  assert.ok(card, 'plan card rendered');
  assert.equal(card.getAttribute('data-rpc'), 'q-1');
  assert.match(textOf(byClass(card, 'kicker')[0]), /^Plan review/);
  assert.equal(textOf(byClass(card, 'plan-goal')[0]), 'Add a cache');
  assert.deepEqual(find(byClass(card, 'plan-steps')[0], (n) => n.tagName === 'LI').map(textOf), ['Read the config', 'Wire it in']);
  assert.match(textOf(card), /and 2 more steps/);
  assert.doesNotMatch(textOf(card), /Add a test/, 'the card shows two steps; the sheet has the rest');
  assert.equal(find(card, (n) => n.tagName === 'TEXTAREA').length, 0, 'feedback lives in the sheet');
  const buttons = find(card, (n) => n.tagName === 'BUTTON');
  assert.deepEqual(buttons.map(textOf), ['Review plan'], 'one action on the card');
  assert.match(buttons[0].className, /btn-primary/);
});

test('the plan card reads a "Goal:" line as the goal', async () => {
  const t = await openWith([]);
  const detail = '**Goal:** split `src/router.js` into one module per resource.\n\n1. Create the modules.\n2. Move the handlers.';
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [{ ...PLAN_QUESTION, detail }] }, { rpcId: 'q-goal' });
  const card = byClass(t.el('#pending'), 'plan')[0];
  assert.equal(textOf(byClass(card, 'plan-goal')[0]), 'split src/router.js into one module per resource.');
  assert.equal(byClass(card, 'plan-more').length, 0);
});

test('Review plan opens the full plan in a large sheet: Approve filled, Keep planning quiet, Reply instead plain', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] }, { rpcId: 'q-1' });
  buttonNamed(byClass(t.el('#pending'), 'plan')[0], 'Review plan').onclick();
  assert.equal(t.el('#sheet').hidden, false, 'the sheet is open');
  assert.equal(t.el('#sheet')['data-size'], 'large');
  assert.equal(textOf(t.el('#sheetTitle')), 'Plan review');
  const doc = byClass(sheetBody(t), 'plan-doc')[0];
  assert.ok(doc, 'the plan is in the sheet body');
  assert.equal(textOf(doc), PLAN_QUESTION.detail, 'the whole plan, not an excerpt');
  assert.ok(find(sheetBody(t), (n) => n.tagName === 'TEXTAREA' && /plan-fb/.test(n.className))[0], 'a feedback field');
  const foot = sheetFoot(t).childNodes;
  assert.deepEqual(foot.map(textOf), ['Approve', 'Keep planning', 'Reply instead'], 'the sticky footer, in order');
  assert.equal(foot[0].className, 'go', 'Approve is the one filled control');
  assert.match(foot[1].className, /btn-secondary/);
  assert.match(foot[2].className, /btn-plain/);
  assert.equal(foot.filter((b) => /\bgo\b|btn-primary/.test(b.className)).length, 1);
});

test('feedback in the plan sheet rides with Keep planning, using dsh\'s labels', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] }, { rpcId: 'q-1' });
  buttonNamed(byClass(t.el('#pending'), 'plan')[0], 'Review plan').onclick();
  const fb = find(sheetBody(t), (n) => n.tagName === 'TEXTAREA')[0];
  fb.value = 'use redis'; fb.oninput();
  buttonNamed(sheetFoot(t), 'Keep planning').onclick();
  await tick(); await tick();
  assert.deepEqual(plain(responds(t)[0].body), {
    type: 'client-response', rpcId: 'q-1',
    result: { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'use redis' }] } } },
  });
  assert.equal(t.S.questions.size, 0);
  assert.equal(t.el('#sheet').hidden, true, 'the sheet closes once answered');
  assert.equal(byClass(t.el('#pending'), 'plan').length, 0);
});

test('Approve in the plan sheet sends the approve label alone, and Reply instead cancels', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] }, { rpcId: 'q-2' });
  buttonNamed(byClass(t.el('#pending'), 'plan')[0], 'Review plan').onclick();
  buttonNamed(sheetFoot(t), 'Approve').onclick();
  await tick(); await tick();
  assert.deepEqual(plain(responds(t)[0].body.result.value.answer), { answers: [{ id: 'plan-review', selected: ['Approve'] }] });

  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] }, { rpcId: 'q-3' });
  buttonNamed(byClass(t.el('#pending'), 'plan')[0], 'Review plan').onclick();
  buttonNamed(sheetFoot(t), 'Reply instead').onclick();
  await tick(); await tick();
  const cancel = responds(t)[1].body;
  assert.equal(cancel.rpcId, 'q-3');
  assert.equal(cancel.result.ok, false);
  assert.equal(cancel.result.error.code, 'cancelled');
  assert.equal(t.el('#sheet').hidden, true);
});

test('dismissing the plan sheet leaves the card and the typed feedback', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] }, { rpcId: 'q-6' });
  buttonNamed(byClass(t.el('#pending'), 'plan')[0], 'Review plan').onclick();
  const fb = find(sheetBody(t), (n) => n.tagName === 'TEXTAREA')[0];
  fb.value = 'half a thought'; fb.oninput();
  t.el('#sheetClose').onclick();
  assert.equal(t.el('#sheet').hidden, true);
  assert.equal(responds(t).length, 0, 'closing the sheet answers nothing');
  assert.ok(t.S.questions.has('q-6'));
  const card = byClass(t.el('#pending'), 'plan')[0];
  assert.ok(card, 'the card is still behind the sheet');
  buttonNamed(card, 'Review plan').onclick();
  assert.equal(find(sheetBody(t), (n) => n.tagName === 'TEXTAREA')[0].value, 'half a thought');
});

test('a plan answered elsewhere closes its open review sheet', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [PLAN_QUESTION] }, { rpcId: 'q-7' });
  buttonNamed(byClass(t.el('#pending'), 'plan')[0], 'Review plan').onclick();
  t.onMux({ type: 'question/resolved', sessionId: 's1', questionRpcId: 'q-7' });
  assert.equal(t.el('#sheet').hidden, true);
  assert.equal(byClass(t.el('#pending'), 'plan').length, 0);
});

const LONG_COMMAND = 'cd packages/api && npm run build -- --mode=production && '
  + Array.from({ length: 60 }, (_, i) => `node scripts/check-${i}.mjs --strict`).join(' && ')
  + '\nnpm test -- --reporter=dot';

test('an approval card shows the whole command with Allow stacked above Deny', async () => {
  const events = [ev(1, 'turn/start', { turn: 1 }), toolCall(2, 'b9', 'bash', { command: LONG_COMMAND }, bashCall(LONG_COMMAND))];
  const t = await openWith(events);
  t.onMux({ type: 'approval/requested', sessionId: 's1', approvalId: 'ap-1', toolName: 'bash', callId: 'b9', reason: 'This command is not on the allow list.' }, { rpcId: 'ap-rpc' });
  const card = byClass(t.el('#pending'), 'approval')[0];
  assert.ok(card);
  assert.equal(textOf(byClass(card, 'kicker')[0]), 'Approval · Bash');
  assert.equal(textOf(byClass(card, 'dec-title')[0]), 'Run this command?');
  assert.equal(textOf(byClass(card, 'dec-why')[0]), 'This command is not on the allow list.');
  assert.equal(textOf(byClass(card, 'cmd-text')[0]), LONG_COMMAND, 'the full command, no clip or ellipsis');
  assert.ok(buttonNamed(card, 'Copy'), 'Copy is an action on the block');
  assert.equal(byClass(card, 'card-head').length, 0, 'no fold header');
  const actions = byClass(card, 'dec-actions')[0].childNodes;
  assert.deepEqual(actions.map(textOf), ['Allow', 'Deny'], 'stacked, Allow first');
  assert.match(actions[0].className, /btn-primary/);
  assert.match(actions[1].className, /btn-plain/);
  assert.doesNotMatch(actions[1].className, /btn-primary/, 'Allow and Deny differ by more than colour');
  actions[0].onclick();
  await tick(); await tick();
  assert.deepEqual(plain(responds(t)[0].body.result), { ok: true, value: { sessionId: 's1', approvalId: 'ap-1', outcome: 'allowed-once' } });
});

test('an approval whose call is not drawn yet repaints with the command once the lookup lands', async () => {
  let history = [];
  const t = harness((method) => {
    if (method === 'session.history') return { events: history, hasMore: false };
    if (method === 'session.models') return { current: { provider: 'p', model: 'm' } };
    return undefined;
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/proj' }];
  await t.openSession('s1');
  // The approval arrives for a call this page has not drawn; the history read finds it.
  history = [ev(1, 'turn/start', { turn: 1 }), toolCall(2, 'b7', 'bash', { command: LONG_COMMAND })];
  t.onMux({ type: 'approval/requested', sessionId: 's1', approvalId: 'ap-2', toolName: 'bash', callId: 'b7' }, { rpcId: 'ap-rpc-2' });
  assert.match(textOf(byClass(t.el('#pending'), 'approval')[0]), /Reading the command/);
  await tick(); await tick(); await tick();
  const card = byClass(t.el('#pending'), 'approval')[0];
  assert.equal(textOf(byClass(card, 'cmd-text')[0]), LONG_COMMAND);
  assert.doesNotMatch(textOf(card), /Reading the command/);
});

test('an approval card uses the arguments the frame carries', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'approval/requested', sessionId: 's1', approvalId: 'ap-3', toolName: 'bash', args: JSON.stringify({ command: 'rm -rf build' }) }, { rpcId: 'ap-rpc-3' });
  assert.equal(textOf(byClass(t.el('#pending'), 'cmd-text')[0]), 'rm -rf build');
});

test('a question card shows a check on the chosen option and Send answer is the primary', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', header: 'Branch', question: 'Which branch?', options: [{ label: 'main' }, { label: 'develop', description: 'the staging line' }] }] }, { rpcId: 'q-4' });
  const card = byClass(t.el('#pending'), 'question')[0];
  assert.ok(card);
  assert.equal(byClass(t.el('#pending'), 'plan').length, 0);
  assert.equal(textOf(byClass(card, 'kicker')[0]), 'Question · Branch');
  assert.equal(textOf(byClass(card, 'dec-title')[0]), 'Which branch?');
  const opts = byClass(card, 'opt');
  assert.equal(opts.length, 2);
  for (const o of opts) {
    assert.equal(o.getAttribute('role'), 'radio');
    assert.ok(byClass(o, 'opt-check')[0], 'every option carries a check mark slot');
  }
  opts[1].onclick();
  assert.equal(opts[1].getAttribute('aria-checked'), 'true');
  assert.match(opts[1].className, /\bsel\b/, 'the chosen row shows its check');
  assert.equal(opts[0].getAttribute('aria-checked'), 'false');
  const actions = byClass(card, 'dec-actions')[0].childNodes;
  assert.deepEqual(actions.map(textOf), ['Send answer', 'Skip']);
  assert.match(actions[0].className, /btn-primary/);
  assert.doesNotMatch(actions[1].className, /btn-primary/);
  const other = find(card, (n) => n.tagName === 'INPUT')[0];
  other.value = 'release'; other.oninput();
  actions[0].onclick();
  await tick(); await tick();
  assert.deepEqual(plain(responds(t)[0].body.result.value.answer), { answers: [{ id: 'q', selected: ['develop'], custom: 'release' }] });
  assert.equal(t.S.questions.size, 0);
});

test('a single-choice question moves like a radio group with the arrow keys', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }] }, { rpcId: 'q-keys' });
  const opts = byClass(t.el('#pending'), 'opt');
  assert.deepEqual(opts.map((o) => o.tabIndex), [0, -1, -1], 'one tab stop, the first option');
  opts[0].onkeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.deepEqual(opts.map((o) => o.getAttribute('aria-checked')), ['false', 'true', 'false']);
  assert.deepEqual(opts.map((o) => o.tabIndex), [-1, 0, -1], 'the chosen option takes the tab stop');
  opts[1].onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(opts[0].getAttribute('aria-checked'), 'true');
  opts[0].onkeydown({ key: 'ArrowUp', preventDefault() {} });
  assert.equal(opts[2].getAttribute('aria-checked'), 'true', 'the arrow wraps round to the last option');
});

test('a multi-select question keeps every chosen option', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [{ id: 'm', question: 'Which checks?', multiSelect: true, options: [{ label: 'lint' }, { label: 'test' }, { label: 'build' }] }] }, { rpcId: 'q-8' });
  const opts = byClass(t.el('#pending'), 'opt');
  assert.equal(opts[0].getAttribute('role'), 'checkbox');
  opts[0].onclick(); opts[2].onclick();
  assert.deepEqual(opts.map((o) => o.getAttribute('aria-checked')), ['true', 'false', 'true']);
  buttonNamed(t.el('#pending'), 'Send answer').onclick();
  await tick(); await tick();
  assert.deepEqual(plain(responds(t)[0].body.result.value.answer), { answers: [{ id: 'm', selected: ['lint', 'build'] }] });
});

test('a waiting card keeps its node, and its chosen option, when another card arrives', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] }, { rpcId: 'q-9' });
  const card = byClass(t.el('#pending'), 'question')[0];
  byClass(card, 'opt')[1].onclick();
  t.onMux({ type: 'approval/requested', sessionId: 's1', approvalId: 'ap-9', toolName: 'bash', args: '{"command":"ls"}' }, { rpcId: 'ap-rpc-9' });
  assert.equal(byClass(t.el('#pending'), 'question')[0], card);
  assert.equal(byClass(card, 'opt')[1].getAttribute('aria-checked'), 'true');
});

test('an expired question says so and can still be answered', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', callId: 'c1', expired: true, questions: [{ id: 'q', question: 'Which branch?', options: [{ label: 'main' }] }] }, { rpcId: 'question:s1:c1' });
  const card = byClass(t.el('#pending'), 'expired')[0];
  assert.ok(card, 'expired card rendered');
  assert.match(textOf(byClass(card, 'kicker')[0]), /^Expired question/);
  assert.match(textOf(byClass(card, 'expired-note')[0]), /You can still answer/);
  assert.deepEqual(find(card, (n) => n.tagName === 'BUTTON' && !/\bopt\b/.test(n.className)).map(textOf), ['Send answer', 'Dismiss']);
  byClass(card, 'opt')[0].onclick();
  buttonNamed(card, 'Send answer').onclick();
  await tick(); await tick();
  const r = responds(t)[0].body.result;
  assert.equal(r.ok, true, 'a late answer still goes to dsh');
  assert.deepEqual(r.value.answer.answers[0].selected, ['main']);
});

test('an expired plan review keeps Review plan and says it expired', async () => {
  const t = await openWith([]);
  t.onMux({ type: 'question/requested', sessionId: 's1', callId: 'c2', expired: true, questions: [PLAN_QUESTION] }, { rpcId: 'question:s1:c2' });
  const card = byClass(t.el('#pending'), 'expired')[0];
  assert.match(textOf(byClass(card, 'kicker')[0]), /^Expired plan review/);
  assert.ok(buttonNamed(card, 'Review plan'));
});

// --- Composer (PR 5): one send/stop control and Queue by default -------------

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the composer has one trailing control and no second stop button', () => {
  const form = HTML.slice(HTML.indexOf('<form id="composer"'), HTML.indexOf('</form>'));
  assert.deepEqual([...form.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]), ['attachBtn', 'micBtn', 'sendBtn']);
  assert.doesNotMatch(HTML, /id="stopBtn"|id="steerBtn"|id="tmplBtn"|>Aa</);
  assert.match(form, /placeholder="Message dsh"/);
});

async function openComposer(extra) {
  const t = harness((method, body) => {
    if (method === 'session.history') return { events: [], hasMore: false };
    if (method === 'session.models') return { current: { provider: 'p', model: 'm' } };
    if (method === 'session.prompt' || method === 'session.cancel' || method === 'respond') return {};
    return extra ? extra(method, body) : undefined;
  });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/proj' }];
  await t.openSession('s1');
  t.btn = () => t.el('#sendBtn');
  t.type = (text) => { t.el('#input').value = text; t.paintComposer(); };
  return t;
}

test('the plus menu lists the four ways to add something and hands the caret to templates', async () => {
  const t = await openComposer();
  t.el('#input').value = 'hello world';
  t.el('#input').selectionStart = 5;
  t.el('#input').selectionEnd = 5;
  t.el('#attachBtn').onclick();
  assert.equal(t.el('#sheet').hidden, false);
  assert.equal(textOf(t.el('#sheetTitle')), 'Add to message');
  const rows = find(t.el('#sheetBody'), (n) => n.tagName === 'BUTTON');
  assert.equal(rows.length, 4);
  const row = (label) => rows.find((r) => textOf(r).startsWith(label));
  for (const label of ['Photo library', 'File', 'Prompt template', 'Commands']) assert.ok(row(label), label);
  row('Prompt template').onclick();
  assert.equal(textOf(t.el('#sheetTitle')), 'Prompt templates', 'the plus sheet is replaced, not stacked');
  assert.equal(t.el('#sheetBack').hidden, true);
  assert.match(textOf(t.el('#sheetBody')), /No templates saved yet/);
});

test('send morphs into stop in the same control while a turn runs and the field is empty', async () => {
  const t = await openComposer();
  t.type('');
  assert.equal(t.btn().getAttribute('data-state'), 'send');
  assert.equal(t.btn().getAttribute('aria-label'), 'Send');
  assert.equal(t.btn().disabled, true, 'muted when empty');

  t.S.running.set('s1', true);
  t.paintComposer();
  assert.equal(t.btn().getAttribute('data-state'), 'stop');
  assert.equal(t.btn().getAttribute('aria-label'), 'Stop');
  assert.equal(t.btn().disabled, false);
  t.btn().onclick();
  await tick();
  assert.ok(t.calls.some((c) => c.method === 'session.cancel'), 'the stop square cancels the turn');

  t.type('one more thing');
  assert.equal(t.btn().getAttribute('data-state'), 'send');
  assert.equal(t.btn().getAttribute('aria-label'), 'Queue message');
  assert.equal(t.el('#modeRow').hidden, false, 'Queue / Steer appears with text while running');

  t.S.running.set('s1', false);
  t.paintComposer();
  assert.equal(t.btn().getAttribute('aria-label'), 'Send');
  assert.equal(t.el('#modeRow').hidden, true, 'no Queue / Steer when nothing runs');
});

test('a message queues by default while a turn runs, and steers only when chosen', async () => {
  const t = await openComposer();
  t.S.running.set('s1', true);
  t.type('queued please');
  await t.send();
  const prompts = () => t.calls.filter((c) => c.method === 'session.prompt').map((c) => c.body.payload.mode);
  assert.deepEqual(prompts(), ['queue']);

  t.type('steer this');
  const seg = byClass(t.el('#modeRow'), 'seg')[0];
  assert.ok(seg, 'the segmented control is in the row');
  assert.equal(seg.getAttribute('role'), 'radiogroup');
  const steer = find(seg, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Steer')[0];
  steer.onclick();
  assert.equal(t.S.steer, true);
  assert.equal(t.btn().getAttribute('aria-label'), 'Steer the running turn');
  await t.send();
  assert.deepEqual(prompts(), ['queue', 'steer']);
  assert.equal(t.S.steer, false, 'Steer is per message; the next one queues again');
});

test('while a decision waits a typed message queues and Send is quiet', async () => {
  const t = await openComposer();
  t.S.running.set('s1', true);
  t.onMux({ type: 'approval/requested', sessionId: 's1', approvalId: 'ap-w', toolName: 'bash', args: '{"command":"ls"}' }, { rpcId: 'ap-rpc-w' });
  t.S.steer = true; // even a Steer chosen earlier
  t.type('');
  assert.equal(t.btn().getAttribute('data-state'), 'stop', 'an empty field still offers Stop');
  assert.match(t.btn().className, /\bquiet\b/, 'but Stop steps back while a decision waits');
  t.type('while you wait');
  assert.match(t.btn().className, /\bquiet\b/, 'Allow keeps the only filled accent');
  assert.equal(t.el('#modeRow').hidden, true, 'no Steer past a waiting decision');
  await t.send();
  assert.equal(t.calls.filter((c) => c.method === 'session.prompt')[0].body.payload.mode, 'queue');

  t.onMux({ type: 'approval/resolved', sessionId: 's1', approvalId: 'ap-w' });
  t.type('after');
  assert.doesNotMatch(t.btn().className, /\bquiet\b/, 'Send is primary again once the decision clears');
});

test('a huge diff keeps bounded ops and exact counts', () => {
  const big = Array.from({ length: 200000 }, (_, i) => 'line ' + i).join('\n');
  const edited = big.replace('line 100000\n', 'changed\n');
  const t0 = Date.now();
  const ops = review.diffLines(big, edited);
  assert.ok(Date.now() - t0 < 2000, 'fast enough for a phone');
  assert.ok(ops.length < 300, `bounded, got ${ops.length}`);
  assert.deepEqual(review.diffStats(ops), { adds: 1, dels: 1 });
  const created = review.diffLines(null, big);
  assert.ok(created.length <= 1001);
  assert.deepEqual(review.diffStats(created), { adds: 200000, dels: 0 });
  assert.equal(created[created.length - 1].op, 'cut');
});

test('an interrupted edit is not counted as a file change', () => {
  const view = { card: 'diff', title: 'edit', diffs: [{ path: '/w/a.txt', oldText: 'a\n', newText: 'b\n' }] };
  const s = review.summarizeTurn([{ id: 'c1', name: 'edit', view, done: true, orphan: true }], { kind: 'interrupted' });
  assert.equal(s.files.length, 0);
});

test('a command that never reported a result is not a success', () => {
  const view = { card: 'terminal', title: 'npm test' };
  const s = review.summarizeTurn([{ id: 'c1', name: 'bash', view, done: true, orphan: true }], { kind: 'completed' });
  assert.equal(s.commands[0].noResult, true);
  assert.equal(s.commands[0].failed, false);
  assert.equal(s.outcome, 'stopped');
});

test('the push notifier uses the same plan-review narrowing as the page', () => {
  const q = { question: 'Ready?', detail: '# Ship it\nsteps', intent: { kind: 'plan-review', approve: 'Approve' },
    options: [{ label: 'Approve' }, { label: 'Keep planning' }, { label: 'Other' }] };
  const frame = { type: 'question/requested', sessionId: 's1', questions: [q] };
  const n = mapFrame({ payload: frame, rpcId: 'r1' }, {});
  assert.ok(!n || n.title !== 'Plan ready for review', 'three options is an ordinary question on the page, so not a plan push');
});

// --- dsh 0.2: no view on the wire -------------------------------------------
// dsh 0.2's tool events: raw arguments on the call, result text and the tool's `meta` on the
// result (dsh-tool-fs's applied hunks, dsh-shell's exit marker in the text). No `view`.
const result02 = (seq, callId, text, meta, isError = false) => {
  const e = toolResult(seq, callId, text, undefined, isError);
  if (meta !== undefined) e.event.data.meta = meta;
  return e;
};
const TURN_02 = [
  ev(1, 'turn/start', { turn: 1 }),
  toolCall(2, 'e1', 'edit', { file_path: '/work/proj/src/a.js', old_string: 'two', new_string: 'TWO\nthree' }),
  result02(3, 'e1', 'Edited', { diffs: [{ path: '/work/proj/src/a.js', oldText: 'one\ntwo\n', newText: 'one\nTWO\nthree\n' }] }),
  toolCall(4, 'w1', 'write', { file_path: '/work/proj/b.txt', content: 'hi\n' }),
  result02(5, 'w1', 'Wrote', { diffs: [], operation: 'create' }),
  toolCall(6, 'b1', 'bash', { command: 'npm test', description: 'Run the tests' }),
  result02(7, 'b1', 'fail\n[exit code: 1]'),
  toolCall(8, 'b2', 'bash', { command: 'npm test', description: 'Run the tests again' }),
  result02(9, 'b2', 'ok'),
  ev(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
];

async function openWith02(events) {
  const t = harness();
  const answer = (method) => {
    if (method === 'session.history') return { events, hasMore: false };
    if (method === 'session.models') return { current: { provider: 'p', model: 'm' } };
    return {};
  };
  t.useDsh02({ rpc: async (method) => answer(method), remote: async () => ({}), has: () => true, isOpen: () => true, connect() {}, close() {} });
  t.S.sessions = [{ sessionId: 's1', cwd: '/work/proj' }];
  await t.openSession('s1');
  return t;
}

test('dsh 0.2: tool rows get their diffs and exit codes, and the turn its summary card', async () => {
  const t = await openWith02(TURN_02);
  const card = byClass(t.el('#msgs'), 'turncard')[0];
  assert.ok(card, 'summary card rendered');
  assert.match(card.className, /passed/);
  const text = textOf(card);
  assert.match(text, /2 files changed\+3 −1/);
  assert.match(text, /src\/a\.js\+2 −1/);
  assert.match(text, /b\.txt\+1 −0/); // a create with empty hunks draws the whole written file
  assert.match(text, /2 commands run, 1 failed/);
  assert.match(text, /BashFailednpm testexit 1/);
  assert.match(text, /Bashnpm testexit 0/);
  const row = t.R.tools.get('e1').el;
  row.open = true; row.ontoggle();
  assert.deepEqual(byClass(row, 'dl').map((n) => textOf(n)), [' one', '-two', '+TWO', '+three']);
  // A command row shows the output without dsh's marker, and the exit code on its own.
  const cmd = t.R.tools.get('b1').el;
  assert.match(cmd.className, /tool err/);
  assert.match(textOf(cmd), /Failed/);
  cmd.open = true; cmd.ontoggle();
  assert.match(textOf(cmd), /outputfailexit 1/);
  assert.doesNotMatch(textOf(cmd), /\[exit code/);
});

test('dsh 0.1 frames without a view keep generic tool rows and a truthful steps receipt', async () => {
  const t = await openWith(TURN_02);
  const receipt = byClass(t.el('#msgs'), 'turncard')[0];
  assert.ok(receipt);
  assert.match(textOf(receipt), /4 steps/);
  assert.equal(byClass(t.R.tools.get('e1').el, 'delta').length, 0);
});

// --- New tool cards: read, grep/glob, web and todos -------------------------
// The views come from the adapter on dsh 0.2 and from the server on dsh 0.1; the
// renderer reads the same card shapes either way. Fixtures are sanitized recordings.
const TOOLCARDS = JSON.parse(fs.readFileSync(new URL('./fixtures/toolcards.json', import.meta.url), 'utf8'));

const TURN_CARDS_02 = [
  ev(1, 'turn/start', { turn: 1 }),
  toolCall(2, 'r1', 'read', TOOLCARDS.read.arguments),
  result02(3, 'r1', 'file body', TOOLCARDS.read.result.meta),
  toolCall(4, 'g1', 'grep', TOOLCARDS.grep.arguments),
  result02(5, 'g1', 'Found 3 matches', TOOLCARDS.grep.result.meta),
  toolCall(6, 'l1', 'glob', TOOLCARDS.glob.arguments),
  result02(7, 'l1', 'docs/README.md', TOOLCARDS.glob.result.meta),
  toolCall(8, 'w1', 'web_search', TOOLCARDS.web_search.arguments),
  result02(9, 'w1', 'Sources: ...', TOOLCARDS.web_search.result.meta),
  toolCall(10, 'f1', 'web_fetch', TOOLCARDS.web_fetch.arguments),
  result02(11, 'f1', 'Fetched https://example.com/docs (HTTP 200)\n\nExample body.', TOOLCARDS.web_fetch.result.meta),
  toolCall(12, 't1', 'todo_write', TOOLCARDS.todo_write.arguments),
  result02(13, 't1', 'Updated todo list: 1 pending, 1 in progress, 1 completed.'),
  ev(14, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
];

test('dsh 0.2: read, grep, glob, web and todo rows get their own cards', async () => {
  const t = await openWith02(TURN_CARDS_02);
  const row = (id) => t.R.tools.get(id).el;

  const read = row('r1');
  assert.match(textOf(byClass(read, 'name')[0]), /^Read$/);
  assert.match(textOf(read), /src\/app\.js/);
  assert.match(textOf(read), /lines 10–12 of 42 · js/);
  read.open = true; read.ontoggle();
  assert.match(textOf(byClass(read, 'detail')[0]), /10 {2}const a = 1;/);

  const grep = row('g1');
  assert.match(textOf(byClass(grep, 'name')[0]), /^Grep$/);
  assert.match(textOf(grep), /TODO/);
  assert.match(textOf(grep), /3 matches in 2 files/);
  grep.open = true; grep.ontoggle();
  const grepDetail = textOf(byClass(grep, 'detail')[0]);
  assert.match(grepDetail, /src\/a\.js/);
  assert.match(grepDetail, /3: \/\/ TODO: cache/);
  assert.match(grepDetail, /src\/b\.js/);
  assert.match(grepDetail, /1: \/\/ TODO: docs/);

  const glob = row('l1');
  assert.match(textOf(glob), /\*\.md/);
  assert.match(textOf(glob), /12 paths \(capped\)/);
  glob.open = true; glob.ontoggle();
  const globDetail = textOf(byClass(glob, 'detail')[0]);
  assert.match(globDetail, /docs\/README\.md/);
  assert.match(globDetail, /docs\/faq\.md/);

  const search = row('w1');
  assert.match(textOf(byClass(search, 'name')[0]), /^Web search$/);
  assert.match(textOf(search), /node 22 lts, node release schedule/);
  assert.match(textOf(search), /2 sources \(capped\)/);
  search.open = true; search.ontoggle();
  const searchDetail = textOf(byClass(search, 'detail')[0]);
  assert.match(searchDetail, /Node 22 is the current LTS\./);
  assert.match(searchDetail, /Node 22 is now available/);
  assert.match(searchDetail, /https:\/\/example\.com\/node22/);

  const fetch = row('f1');
  assert.match(textOf(byClass(fetch, 'name')[0]), /^Fetch$/);
  assert.match(textOf(fetch), /https:\/\/example\.com\/docs/);
  assert.match(textOf(fetch), /HTTP 200/);
  fetch.open = true; fetch.ontoggle();
  assert.match(textOf(byClass(fetch, 'detail')[0]), /Example body\./);

  const todos = row('t1');
  assert.match(textOf(byClass(todos, 'name')[0]), /^Todos$/);
  assert.match(textOf(todos), /1\/3 done · 1 in progress/);
  todos.open = true; todos.ontoggle();
  const todoDetail = textOf(byClass(todos, 'detail')[0]);
  assert.match(todoDetail, /◐Read the files/);
  assert.match(todoDetail, /○Summarize/);
  assert.match(todoDetail, /✓Report/);
});

test('dsh 0.1: the same cards render from the view the server attaches', async () => {
  const call = (id, name, args) => ({ for: 'call', view: dsh02.toolCallView(name, args) });
  const res = (name, args, meta) => ({ for: 'result', view: dsh02.toolResultView(name, args, { content: [{ type: 'text', text: 'body' }], isError: false, meta }) });
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    toolCall(2, 'r1', 'read', TOOLCARDS.read.arguments, call('r1', 'read', TOOLCARDS.read.arguments)),
    toolResult(3, 'r1', 'file body', res('read', TOOLCARDS.read.arguments, TOOLCARDS.read.result.meta)),
    toolCall(4, 'g1', 'grep', TOOLCARDS.grep.arguments, call('g1', 'grep', TOOLCARDS.grep.arguments)),
    toolResult(5, 'g1', 'Found 3 matches', res('grep', TOOLCARDS.grep.arguments, TOOLCARDS.grep.result.meta)),
    toolCall(6, 't1', 'todo_write', TOOLCARDS.todo_write.arguments, { for: 'call', view: { card: 'generic', title: 'Update todo list', kind: 'other', rawInput: TOOLCARDS.todo_write.arguments.todos } }),
    toolResult(7, 't1', 'Updated todo list: 1 pending, 1 in progress, 1 completed.'),
    ev(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  const t = await openWith(events);
  assert.match(textOf(t.R.tools.get('r1').el), /lines 10–12 of 42 · js/);
  assert.match(textOf(t.R.tools.get('g1').el), /3 matches in 2 files/);
  assert.match(textOf(t.R.tools.get('t1').el), /1\/3 done · 1 in progress/);
  t.R.tools.get('t1').el.open = true; t.R.tools.get('t1').el.ontoggle();
  assert.match(textOf(byClass(t.R.tools.get('t1').el, 'detail')[0]), /✓Report/);
});


test('a running turn keeps narration before a tool call out of the answer', async () => {
  const t = await openWith([ev(1, 'turn/start', { turn: 1 }), assistant(2, [prose('Looking at the handler first.')]), toolCall(3, 'b', 'bash', { command: 'true' }, bashCall('true'))]);
  const turn = byClass(t.el('#msgs'), 'transcript-turn')[0];
  assert.equal(byClass(turn, 'turn-answer').length, 0);
  assert.match(byClass(turn, 'act-text')[0].innerHTML, /Looking at the handler first/);
});

test('a command that never reported a result is not marked done', async () => {
  const t = await openWith([ev(1, 'turn/start', { turn: 1 }), toolCall(2, 'n', 'bash', { command: 'sleep 9' }, bashCall('sleep 9')), ev(3, 'turn/end', { turn: 1, reason: { kind: 'aborted' } })]);
  const row = t.R.tools.get('n').el;
  assert.equal(byClass(row, 'done').length, 0);
  assert.ok(byClass(row, 'idle').length);
});
