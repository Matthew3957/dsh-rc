// The demo mock (scripts/demo-dsh.mjs) and its fixtures feed the README screenshots, so a
// broken fixture would quietly ship a broken picture. These tests keep the fixtures
// well formed, free of anything that looks real, and served in the shapes app.js reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDemoDsh } from '../scripts/demo-dsh.mjs';
import { buildDemo, ID, APPROVAL_RPC, PLAN_RPC } from '../scripts/demo-fixtures.mjs';

const NOW = Date.UTC(2026, 0, 15, 14, 30, 0);

async function call(base, method, payload = {}) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}

test('the fixtures are the same at the same instant', () => {
  const plain = (d) => JSON.stringify({ ...d, histories: [...d.histories], historyProjections: undefined });
  assert.equal(plain(buildDemo(NOW)), plain(buildDemo(NOW)));
});

test('every history has contiguous seqs and pairs each tool call with a result', () => {
  const demo = buildDemo(NOW);
  for (const [sessionId, events] of demo.histories) {
    events.forEach((e, i) => assert.equal(e.event.seq, i, `${sessionId} seq ${i}`));
    const called = new Set(events.filter((e) => e.event.type === 'tool/call').map((e) => e.event.data.callId));
    const answered = new Set(events.filter((e) => e.event.type === 'tool/result').map((e) => e.event.data.message.source.callId));
    for (const id of answered) assert.ok(called.has(id), `${sessionId}: result for unknown call ${id}`);
    // The only calls left open are the running turns' (the approval waits on one).
    const open = [...called].filter((id) => !answered.has(id));
    const running = demo.sessions.find((s) => s.sessionId === sessionId).running;
    assert.ok(running || open.length === 0, `${sessionId} is idle but has open calls ${open}`);
  }
  assert.equal(demo.approval.rpcId, APPROVAL_RPC);
  assert.equal(demo.plan.rpcId, PLAN_RPC);
  const openCall = demo.histories.get(ID.pagination).find((e) => e.event.type === 'tool/call' && e.event.data.callId === demo.approval.payload.callId);
  assert.ok(openCall, 'the approval names a call in the log');
});

test('the session token totals are the sum of the per-step usage', () => {
  const demo = buildDemo(NOW);
  const events = demo.histories.get(ID.offByOne);
  const sum = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const { event } of events) {
    const u = event.type === 'assistant/message' && event.data.usage;
    if (!u) continue;
    sum.uncachedInputTokens += u.inputTokens; sum.outputTokens += u.outputTokens;
    sum.cacheReadTokens += u.cacheReadTokens; sum.cacheWriteTokens += u.cacheWriteTokens;
  }
  assert.deepEqual(demo.historyProjections(ID.offByOne).values.tokenUsage, sum);
});

test('nothing in the fixtures looks like a real host, person or path', () => {
  const text = JSON.stringify(buildDemo(NOW));
  assert.doesNotMatch(text, /\/home\/|\/Users\/|@[A-Za-z0-9.-]+\.[a-z]{2,}|\d+\.\d+\.\d+\.\d+|ts\.net/i);
  for (const s of buildDemo(NOW).sessions) assert.match(s.cwd, /^\/work\/demo\//);
});

test('the mock answers the reads the page makes and 404s the rest', async (t) => {
  const mock = await startDemoDsh({ now: NOW });
  t.after(() => mock.close());
  const describe = await call(mock.url, 'host.describe');
  assert.equal(describe.body.result.ok, true);
  assert.equal(describe.body.rpcId, 'r1');

  const list = await call(mock.url, 'session.list');
  const items = list.body.result.value.items;
  assert.equal(items.filter((s) => s.running).length, 2);
  assert.ok(items.every((s) => typeof s.sessionId === 'string' && typeof s.updatedAt === 'number' && s.blank === false));
  assert.deepEqual(items.map((s) => s.updatedAt), [...items.map((s) => s.updatedAt)].sort((a, b) => b - a));

  const hist = await call(mock.url, 'session.history', { sessionId: ID.offByOne, maxMessages: 24 });
  assert.ok(hist.body.result.value.events.length > 10);
  assert.ok(hist.body.result.value.projections.values.tokenUsage);
  const gone = await call(mock.url, 'session.history', { sessionId: 'nope' });
  assert.equal(gone.body.result.ok, false);
  assert.equal(gone.body.result.error.code, 'session-not-found');

  const subs = await call(mock.url, 'subagent.list', { parentSessionId: ID.pagination });
  assert.equal(subs.body.result.value.entries.length, 2);
  const cmds = await call(mock.url, 'commands/list', { args: { agentId: ID.pagination } });
  assert.deepEqual(cmds.body.result.value, []);

  const search = await call(mock.url, 'session.search', { query: 'router' });
  assert.ok(search.body.result.value.items.some((i) => i.sessionId === ID.router));

  // A method the mock does not serve answers like an unknown dsh method.
  const unknown = await call(mock.url, 'session.create', {});
  assert.equal(unknown.status, 404);
});

test('the mux socket replays subscribed, job and pending frames on open', async (t) => {
  const mock = await startDemoDsh({ now: NOW });
  t.after(() => mock.close());
  mock.setPending({ approval: true, plan: true });
  const frames = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(mock.url.replace('http', 'ws') + '/api/events.mux');
    const timer = setTimeout(() => { ws.close(); resolve(); }, 400);
    ws.onmessage = (e) => frames.push(JSON.parse(e.data));
    ws.onerror = () => { clearTimeout(timer); reject(new Error('mux socket failed')); };
  });
  const types = frames.map((f) => f.payload.type);
  assert.ok(types.includes('session/subscribed'));
  assert.ok(types.includes('session/jobs'));
  assert.ok(types.includes('approval/requested'));
  const question = frames.find((f) => f.payload.type === 'question/requested');
  assert.equal(question.rpcId, PLAN_RPC);
  assert.equal(question.payload.questions[0].intent.kind, 'plan-review');
});
