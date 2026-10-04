import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { bareCode, createClient, fromControl, fromEvents, fromFollow, fromPluginInventory, fromWorkspace, goalOf, goalStatus, inboxToQueue, liveChunksOf, localizedText, toolCallView, toolResultView, todosFrom, fromJobFollow, fromJobs, questionKey } from '../public/dsh02.js';
import { createNotifier } from '../server/notify.mjs';

// Recorded and sanitized tool/result `meta` shapes; see the file's `_source`.
const FIXTURES = JSON.parse(fs.readFileSync(new URL('./fixtures/toolcards.json', import.meta.url), 'utf8'));
const resultOf = (f) => ({ content: [{ type: 'text', text: 'result text' }], isError: false, ...f.result });

test('api-session emits become the host frames the page reads', () => {
  const summary = { sessionId: 's1', parentSessionId: 'p', origin: 'subagent', blank: false, cwd: '/w', running: true };
  assert.deepEqual(fromEvents({ type: 'emit', event: 'api-session/added', args: [summary] })[0].payload,
    { type: 'host/session-added', sessionId: 's1', parentSessionId: 'p', origin: 'subagent', blank: false, cwd: '/w', running: true });
  assert.deepEqual(fromEvents({ type: 'emit', event: 'api-session/status', args: ['s1', true] })[0], { kind: 'host', payload: { type: 'host/session-status', sessionId: 's1', running: true } });
  assert.equal(fromEvents({ type: 'emit', event: 'api-session/removed', args: ['s1'] })[0].payload.type, 'host/session-removed');
  assert.equal(fromEvents({ type: 'emit', event: 'api-session/error', args: ['s1', 'boom'] })[0].payload.message, 'boom');
  assert.deepEqual(fromEvents({ type: 'emit', event: 'commands/change', args: [] }), []);
  assert.deepEqual(fromEvents({ type: 'ready', clientId: 'c' }), []);
});

test('approval and question waterfalls carry the event id as rpcId, and cancel resolves them', () => {
  const pending = new Map();
  const a = fromEvents({ type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's1', request: { toolName: 'bash', callId: 'c1', reason: 'because' } }, pending)[0];
  assert.deepEqual(a.payload, { type: 'approval/requested', sessionId: 's1', approvalId: 'e1', callId: 'c1', toolName: 'bash', reason: 'because' });
  assert.equal(a.env.rpcId, 'e1');
  const displayOnly = fromEvents({ type: 'waterfall', event: 'approval/request', eventId: 'e2', agentId: 's1', request: { toolName: 'bash', displayReason: { en: 'english' } } }, pending)[0];
  assert.equal(displayOnly.payload.reason, 'english');
  const q = fromEvents({ type: 'waterfall', event: 'user-questions/request', eventId: 'e3', agentId: 's1', request: { questions: [{ id: 'q', question: 'Q?' }], wait: { callId: 'c9' } } }, pending)[0];
  assert.deepEqual(q.payload, { type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', question: 'Q?' }], callId: 'c9' });
  assert.equal(fromEvents({ type: 'cancel', eventId: 'e1' }, pending)[0].payload.type, 'approval/resolved');
  assert.deepEqual(fromEvents({ type: 'cancel', eventId: 'e3' }, pending)[0].payload, { type: 'question/resolved', questionRpcId: 'e3' });
  assert.deepEqual(fromEvents({ type: 'cancel', eventId: 'unknown' }, pending), []);
  assert.deepEqual(fromEvents({ type: 'waterfall', event: 'something/else', eventId: 'x', agentId: 'a', request: {} }), []);
});

test('the notifier treats 0.2 frames like 0.1 ones', () => {
  const n = createNotifier({ now: () => 0 });
  const fed = (items) => items.flatMap((i) => fromEvents(i)).map((f) => n.handle({ payload: f.payload })).filter(Boolean);
  const out = fed([
    { type: 'emit', event: 'api-session/status', args: ['s1', true] },
    { type: 'emit', event: 'api-session/status', args: ['s1', false] },
    { type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's2', request: { toolName: 'bash', reason: 'wider sandbox' } },
    { type: 'waterfall', event: 'user-questions/request', eventId: 'e2', agentId: 's3', request: { questions: [{ id: 'a', question: 'Which?' }] } },
  ]);
  assert.deepEqual(out.map((x) => x.kind), ['finished', 'approval', 'question']);
  assert.match(out[1].body, /bash: wider sandbox/);
});

test('inbox messages become the page queue; only typed ones are not context', () => {
  const items = inboxToQueue({
    'next-turn': [{ id: 'a', source: { kind: 'user' }, content: [] }, { id: 'b', source: { kind: 'runtime-context' }, content: [] }],
    'next-step': [{ id: 'c', source: { kind: 'user' }, content: [] }],
  });
  assert.deepEqual(items.map((i) => [i.id, i.placement]), [['a', 'queued'], ['b', 'context'], ['c', 'steering']]);
  assert.equal(items[0].message.id, 'a');
  assert.deepEqual(inboxToQueue(null), []);
});

test('localizedText picks the asked language, then English, and never invents text', () => {
  assert.equal(localizedText('plain', 'en-US'), 'plain');
  assert.equal(localizedText({ en: 'fallback', zh: '中文' }, 'zh-Hans'), '中文');
  assert.equal(localizedText({ en: 'fallback', zh: '中文' }, 'fr'), 'fallback');
  assert.equal(localizedText({ fr: 'seul' }, 'de'), 'seul');
  assert.equal(localizedText('', 'en'), undefined);
  assert.equal(localizedText(undefined, 'en'), undefined);
  assert.equal(localizedText(null), undefined);
});

test('fromPluginInventory resolves 0.2 metadata and presets, and leaves 0.1 entries alone', () => {
  const snapshot = {
    managementAvailable: true,
    entries: [
      { entryId: 'include:plugin-manager', moduleName: '@deepseek-ai/dsh-plugin-manager', enabled: true, fiberPhase: 'active', meta: { title: { en: 'Plugin manager', zh: '插件管理' }, description: 'Manage the profile' } },
      { entryId: 'include:broken', moduleName: '@deepseek-ai/dsh-broken', enabled: true, fiberPhase: 'failed', meta: { title: 'Broken thing', description: { en: 'It failed', zh: '它失败了' } } },
    ],
    agentPresets: [
      { id: 'standard', name: 'Standard', isDefault: true, rows: [{ entryId: 'persona', moduleName: '@deepseek-ai/dsh-persona', enabled: true, fiberPhase: 'active' }] },
      { id: 'minimal', broken: 'composition unreadable', rows: [] },
      { id: 'failing', name: 'Failing', rows: [{ entryId: 'x', moduleName: 'x', enabled: true, fiberPhase: 'failed' }, { entryId: 'y', moduleName: 'y', enabled: false, fiberPhase: null }] },
    ],
  };
  const out = fromPluginInventory(snapshot, { locale: 'zh-Hans' });
  assert.equal(out.managementAvailable, true);
  assert.equal(out.entries[0].title, '插件管理');
  assert.equal(out.entries[0].description, 'Manage the profile');
  assert.equal(out.entries[1].description, '它失败了');
  assert.equal(out.entries[1].fiberPhase, 'failed');
  const broken = out.presets.find((p) => p.id === 'minimal');
  assert.equal(broken.broken, 'composition unreadable');
  assert.equal(broken.failed, 0);
  assert.equal(out.presets.find((p) => p.id === 'standard').isDefault, true);
  assert.equal(out.presets.find((p) => p.id === 'failing').failed, 1);

  const old = fromPluginInventory({ entries: [{ entryId: 'e', moduleName: 'm', enabled: true, fiberPhase: 'active' }] });
  assert.equal(old.entries[0].title, undefined);
  assert.equal(old.entries[0].description, undefined);
  assert.deepEqual(old.presets, []);
  assert.equal(old.managementAvailable, false);
  assert.deepEqual(fromPluginInventory({ items: [{ entryId: 'i', moduleName: 'm' }] }).entries.map((e) => e.entryId), ['i']);
  assert.deepEqual(fromPluginInventory(null), { entries: [], presets: [], managementAvailable: false });
});

test('control baseline and increments become projection frames, with the queue from the inbox', () => {
  const frames = fromControl({ type: 'baseline', value: { projections: { s1: { asOfSeq: 7, values: { title: 'T', inbox: { 'next-turn': [], 'next-step': [] } } } } } });
  assert.deepEqual(frames.map((f) => f.payload.type), ['session/projection', 'session/projection', 'session/queue']);
  assert.deepEqual(frames[0].payload, { type: 'session/projection', sessionId: 's1', key: 'title', value: 'T', seq: 7 });
  const one = fromControl({ type: 'projection', sessionId: 's1', key: 'plan', value: { active: false }, seq: 9 });
  assert.equal(one[0].payload.seq, 9);
});

test('the workspace feed supplies the archive set', () => {
  assert.deepEqual(fromWorkspace({ type: 'baseline', value: { items: [], archivedSessionIds: ['a'] } })[0].payload, { type: 'host/archived-sessions-changed', archivedSessionIds: ['a'] });
  assert.deepEqual(fromWorkspace({ type: 'archived', archivedSessionIds: ['a', 'b'] })[0].payload.archivedSessionIds, ['a', 'b']);
  assert.deepEqual(fromWorkspace({ type: 'order', workspaceIds: [] }), []);
});

test('follow events are session events; assistant frames are transient chunks keyed by attempt', () => {
  const attempts = new Map();
  const ev = { type: 'turn/start', seq: 3, time: 1, data: { turn: 1 } };
  assert.deepEqual(fromFollow({ type: 'event', event: ev }, 's1', attempts)[0].payload, { type: 'session/event', sessionId: 's1', event: ev });
  assert.deepEqual(fromFollow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta' } } }, 's1', attempts), []); // no start seen yet
  assert.deepEqual(fromFollow({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', turn: 2, step: 4 } }, 's1', attempts), []);
  const chunk = fromFollow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', text: 'x' } } }, 's1', attempts)[0].payload;
  assert.equal(chunk.transient, true);
  assert.deepEqual(chunk.event, { type: 'assistant/chunk', data: { turn: 2, step: 4, chunk: { type: 'text-delta', text: 'x' } } });
  fromFollow({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'a' } }, 's1', attempts);
  assert.equal(attempts.size, 0);
});

test('the reply mid-stream at a snapshot is replayed as chunks', () => {
  const snap = { assistantStream: { activeAttempt: { turn: 1, step: 2, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: 'hi' } }, { type: 'text-delta', text: 'yo' }] } } };
  const out = liveChunksOf(snap, 's1');
  assert.deepEqual(out.map((o) => o.event.data.chunk.text), ['hi', 'yo']);
  assert.equal(out[0].event.data.step, 2);
  assert.deepEqual(liveChunksOf({}, 's1'), []);
});

test('job/list rows become the session/jobs frame with just the 0.1 view fields', () => {
  const frame = fromJobs({ type: 'rows', jobs: [
    { id: 'bash-1', kind: 'bash', label: 'sleep 180', owner: 's1', outputLimitBytes: 999, status: 'running', progress: '3/10', startedAt: 5, output: { total: 12, earliest: 0, spillPaths: ['/tmp/spill'] } },
    { id: 'bash-2', kind: 'bash', label: 'make', status: 'completed', detail: 'exit code: 0', startedAt: 1, finishedAt: 9, output: { total: 4, earliest: 2 } },
  ] }, 's1');
  assert.equal(frame.length, 1);
  assert.deepEqual(frame[0].payload, { type: 'session/jobs', sessionId: 's1', jobs: [
    { id: 'bash-1', kind: 'bash', label: 'sleep 180', status: 'running', startedAt: 5, output: { total: 12, earliest: 0 } },
    { id: 'bash-2', kind: 'bash', label: 'make', status: 'completed', detail: 'exit code: 0', startedAt: 1, finishedAt: 9, output: { total: 4, earliest: 2 } },
  ] });
  // The empty whole-set frame still reaches the page, so "the last job finished" is expressible.
  assert.deepEqual(fromJobs({ type: 'rows', jobs: [] }, 's1')[0].payload.jobs, []);
  assert.deepEqual(fromJobs({ type: 'rows' }, 's1')[0].payload.jobs, []);
  assert.deepEqual(fromJobs({ type: 'other' }, 's1'), []);
});

test('job/follow frames become transient job/output frames', () => {
  const job = { id: 'bash-1', kind: 'bash', label: 'sleep 180', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } };
  assert.deepEqual(fromJobFollow({ type: 'opened', job, from: 0 }, 's1', 'bash-1')[0].payload, { type: 'job/output', sessionId: 's1', jobId: 'bash-1', kind: 'opened', job });
  assert.deepEqual(fromJobFollow({ type: 'output', chunks: [{ at: 0, text: 'hi' }], next: 2 }, 's1', 'bash-1')[0].payload, { type: 'job/output', sessionId: 's1', jobId: 'bash-1', kind: 'output', chunks: [{ at: 0, text: 'hi' }], lossy: false });
  assert.deepEqual(fromJobFollow({ type: 'output', chunks: [], next: 2, lossy: true }, 's1', 'bash-1')[0].payload.lossy, true);
  assert.deepEqual(fromJobFollow({ type: 'status', job: { id: 'bash-1', status: 'completed', detail: 'exit code: 0' } }, 's1', 'bash-1')[0].payload.job.detail, 'exit code: 0');
  assert.deepEqual(fromJobFollow({ type: 'nope' }, 's1', 'bash-1'), []);
});

test('bareCode drops the namespace dsh 0.2 puts on error codes', () => {
  assert.equal(bareCode('session/fork-unavailable'), 'fork-unavailable');
  assert.equal(bareCode('plain'), 'plain');
});

class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.last = this; }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
  open() { this.readyState = 1; this.onopen(); }
  push(m) { this.onmessage({ data: JSON.stringify(m) }); }
}

function harness() {
  const calls = [];
  const frames = [];
  const state = { up: 0, down: 0 };
  const client = createClient({
    transport: async (endpoint, payload, rpcId) => { calls.push({ endpoint, payload, rpcId }); return { echoed: endpoint }; },
    wsUrl: 'ws://x/api/remote.mux',
    WebSocketImpl: FakeSocket,
    onFrame: (kind, payload, env) => frames.push({ kind, payload, env }),
    onUp: () => { state.up += 1; },
    onDown: () => { state.down += 1; },
    timeoutMs: 50,
  });
  return { client, calls, frames, state };
}

test('connect opens the three feeds and reports up on the ready item', () => {
  const { client, state } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  assert.deepEqual(ws.sent.map((m) => [m.streamId, m.endpoint]), [['ev', '$events'], ['ctl', 'session/control'], ['ws', 'workspace/follow']]);
  assert.deepEqual(ws.sent[0].payload, { args: {} });
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'ready', clientId: 'cid', host: { home: '/srv/example' } } });
  assert.equal(state.up, 1);
  assert.equal(client.clientId(), 'cid');
  client.close();
  assert.equal(state.down, 0); // close() from our side is not a loss
  client.connect();
  FakeSocket.last.readyState = 1;
  FakeSocket.last.onclose({});
  assert.equal(state.down, 1);
});

test('the 0.1 method names the page calls land on 0.2 endpoints with named args', async () => {
  const { client, calls } = harness();
  await client.rpc('session.list', {});
  await client.rpc('session.prompt', { sessionId: 's', mode: 'steer', content: [{ type: 'text', text: 'hi' }], clientTimeZone: 'UTC' }, 'req1');
  await client.rpc('session.cancel', { sessionId: 's' });
  await client.rpc('session.updateQueue', { sessionId: 's', itemId: 'i', action: { kind: 'remove' } });
  await client.rpc('session.create', { cwd: '/w', agentPreset: 'standard' });
  await client.rpc('session.selectModel', { sessionId: 's', provider: 'p', model: 'm' });
  await client.rpc('host.listDirectory', { path: '/w' });
  await client.remote('commands/execute', { agentId: 's', line: '/x', images: [{ mediaType: 'image/png', data: 'AA', name: 'a.png' }] });
  await client.remote('commands/list', { agentId: 's' });
  assert.deepEqual(calls.map((c) => [c.endpoint, c.payload.args]), [
    ['session/list', { _request: {} }],
    ['session/prompt', { request: { requestId: 'req1', sessionId: 's', mode: 'steer', content: [{ type: 'text', text: 'hi' }], clientTimeZone: 'UTC' } }],
    ['session/cancel', { request: { sessionId: 's' } }],
    ['session/updateQueue', { request: { sessionId: 's', itemId: 'i', action: { kind: 'remove' } } }],
    ['session/create', { request: { cwd: '/w', agentPreset: 'standard' } }],
    ['session/selectModel', { request: { sessionId: 's', provider: 'p', model: 'm' } }],
    ['directoryPicker/list', { path: '/w' }],
    ['commands/execute', { agentId: 's', line: '/x', submittedAttachments: [{ type: 'image', mediaType: 'image/png', data: 'AA', name: 'a.png' }] }],
    ['commands/list', { agentId: 's' }],
  ]);
  assert.equal(calls[1].rpcId, 'req1');
});

test('the plugin inventory passes through as the same endpoint on both APIs', async () => {
  const { client, calls } = harness();
  await client.remote('pluginInventory/list', {});
  assert.deepEqual(calls.at(-1), { endpoint: 'pluginInventory/list', payload: { args: {} }, rpcId: undefined });
});

test('a method with no 0.2 equivalent rejects as unsupported', async () => {
  const { client } = harness();
  await assert.rejects(client.rpc('session.export', {}), (e) => e.code === 'unsupported');
  assert.equal(client.has('session.list'), true);
  assert.equal(client.has('host.describe'), false);
});

test('errors lose their 0.2 namespace on the way out', async () => {
  const client = createClient({ transport: async () => { throw Object.assign(new Error('nope'), { code: 'session/fork-unavailable' }); }, wsUrl: 'ws://x', WebSocketImpl: FakeSocket, onFrame() {} });
  await assert.rejects(client.rpc('session.fork', { sessionId: 's' }), (e) => e.code === 'fork-unavailable');
});

test('subagent.list follows the catalog down and probes a child the control feed skipped', async () => {
  const proj = (catalog, timing) => ({ values: { subagentCatalog: catalog, ...(timing ? { subagentTiming: timing } : {}) } });
  const bySession = {
    root: proj([{ id: 'c1', mode: 'one-shot', label: 'child' }]),
    c1: proj([{ id: 'g1', mode: 'continuable', label: 'grandchild' }], { settledMs: 0, active: { since: 5, through: 9 } }),
    g1: proj([]),
  };
  const calls = [];
  const client = createClient({
    transport: async (endpoint, payload) => { calls.push([endpoint, payload.args.request.sessionId]); return bySession[payload.args.request.sessionId]; },
    wsUrl: 'ws://x', WebSocketImpl: FakeSocket, onFrame() {},
  });
  const root = await client.rpc('subagent.list', { parentSessionId: 'root' });
  assert.deepEqual(root.entries, [{ kind: 'child', id: 'c1', mode: 'one-shot', label: 'child', activity: 'running', hasChildren: true }]);
  // The grandchild's catalog was cached by the probe, so the child's own listing
  // reads no child session twice; it only probes the grandchild.
  const before = calls.length;
  const child = await client.rpc('subagent.list', { parentSessionId: 'c1' });
  assert.deepEqual(child.entries, [{ kind: 'child', id: 'g1', mode: 'continuable', label: 'grandchild', activity: 'inactive', hasChildren: false }]);
  assert.ok(calls.slice(before).every(([, sessionId]) => sessionId === 'g1'), 'only the grandchild is read again');
  assert.equal(calls.slice(0, before).filter(([, sessionId]) => sessionId === 'c1').length, 1);
});

test('a status frame fills in a child activity the timing probe did not know', async () => {
  const { client, frames } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  ws.push({ type: 'item', streamId: 'ctl', value: { type: 'projection', sessionId: 's1', key: 'subagentCatalog', value: [{ id: 'c1', mode: 'one-shot', label: 'child' }], seq: 4 } });
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'emit', event: 'api-session/status', args: ['c1', true] } });
  const v = await client.rpc('subagent.list', { parentSessionId: 's1' });
  assert.equal(v.entries[0].activity, 'running');
  assert.equal(v.entries[0].hasChildren, false);
  assert.ok(frames.length >= 0);
});

test('a continued question from the projection becomes an expired card that leaves with the row', () => {
  const { client, frames } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'ready', clientId: 'cid', host: {} } });
  ws.push({ type: 'item', streamId: 'ctl', value: { type: 'projection', sessionId: 's1', key: 'userQuestions', value: { active: [{ callId: 'c1', questions: [{ id: 'q', question: 'Which?' }], state: 'continued' }], settled: [] }, seq: 3 } });
  const q = frames.find((f) => f.payload.type === 'question/requested');
  assert.equal(q.payload.expired, true);
  assert.equal(q.payload.callId, 'c1');
  assert.equal(q.env.rpcId, questionKey('s1', 'c1'));
  // The projection dropping the row retires the card.
  ws.push({ type: 'item', streamId: 'ctl', value: { type: 'projection', sessionId: 's1', key: 'userQuestions', value: { active: [], settled: [] }, seq: 9 } });
  assert.deepEqual(frames.at(-1).payload, { type: 'question/resolved', questionRpcId: questionKey('s1', 'c1') });
});

test('an expired question is answered through userQuestions/answer, not the waterfall', async () => {
  const { client, calls, frames } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'ready', clientId: 'cid', host: {} } });
  ws.push({ type: 'item', streamId: 'ctl', value: { type: 'projection', sessionId: 's1', key: 'userQuestions', value: { active: [{ callId: 'c1', questions: [{ id: 'q', question: 'Which?' }], state: 'continued' }], settled: [] }, seq: 3 } });
  await client.respond(questionKey('s1', 'c1'), { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'q', selected: ['A'] }] } } });
  assert.deepEqual(calls.at(-1), { endpoint: 'userQuestions/answer', payload: { args: { agentId: 's1', callId: 'c1', answer: { answers: [{ id: 'q', selected: ['A'] }] } } }, rpcId: undefined });
  assert.deepEqual(frames.at(-1).payload, { type: 'question/resolved', questionRpcId: questionKey('s1', 'c1') });
});

test('answering an expired question dsh no longer accepts rejects', async () => {
  const client = createClient({ transport: async () => false, wsUrl: 'ws://x', WebSocketImpl: FakeSocket, onFrame() {} });
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  ws.push({ type: 'item', streamId: 'ctl', value: { type: 'projection', sessionId: 's1', key: 'userQuestions', value: { active: [{ callId: 'c1', questions: [{ id: 'q', question: 'Which?' }], state: 'continued' }] }, seq: 3 } });
  await assert.rejects(client.respond(questionKey('s1', 'c1'), { ok: true, value: { sessionId: 's1', answer: { answers: [] } } }), (e) => e.code === 'question-closed');
});

test('a live waterfall is retired when the projection reports the same call continued', () => {
  const { client, frames } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'ready', clientId: 'cid', host: {} } });
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'waterfall', event: 'user-questions/request', eventId: 'e1', agentId: 's1', request: { questions: [{ id: 'q', question: 'Which?' }], wait: { callId: 'c1', timed: true } } } });
  assert.equal(frames.at(-1).env.rpcId, 'e1');
  ws.push({ type: 'item', streamId: 'ctl', value: { type: 'projection', sessionId: 's1', key: 'userQuestions', value: { active: [{ callId: 'c1', questions: [{ id: 'q', question: 'Which?' }], state: 'continued' }] }, seq: 4 } });
  const resolved = frames.filter((f) => f.payload.type === 'question/resolved').map((f) => f.payload.questionRpcId);
  assert.deepEqual(resolved, ['e1']);
  const expired = frames.filter((f) => f.payload.type === 'question/requested' && f.payload.expired);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].env.rpcId, questionKey('s1', 'c1'));
});

test('an expired question whose reply is already queued in the inbox stays hidden', () => {
  const { client, frames } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'ready', clientId: 'cid', host: {} } });
  ws.push({ type: 'item', streamId: 'ctl', value: { type: 'projection', sessionId: 's1', key: 'userQuestions', value: { active: [{ callId: 'c1', questions: [{ id: 'q', question: 'Which?' }], state: 'continued' }] }, seq: 4 } });
  assert.equal(frames.at(-1).payload.expired, true);
  ws.push({ type: 'item', streamId: 'ctl', value: { type: 'projection', sessionId: 's1', key: 'inbox', value: { 'next-turn': [{ id: 'm1', source: { kind: 'user-question-reply', callId: 'c1' } }] }, seq: 5 } });
  assert.deepEqual(frames.at(-1).payload, { type: 'question/resolved', questionRpcId: questionKey('s1', 'c1') });
});

test('opening a session follows it and resolves with the snapshot as a 0.1 history reply', async () => {
  const { client, frames } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  const p = client.rpc('session.history', { sessionId: 's1', maxMessages: 24 });
  const open = ws.sent.find((m) => m.endpoint === 'session/follow');
  assert.deepEqual(open.payload.args.request.address, { kind: 'session', sessionId: 's1' });
  assert.equal(open.payload.args.request.assistantStream, true);
  ws.push({ type: 'item', streamId: open.streamId, value: { type: 'snapshot', cursor: 5, hasMore: true, records: [{ type: 'event', event: { type: 'turn/start', seq: 4, data: {} } }], projections: { asOfSeq: 5, values: { title: 'T' } } } });
  const v = await p;
  assert.equal(v.cursor, 5);
  assert.equal(v.hasMore, true);
  assert.deepEqual(v.events, [{ sessionId: 's1', event: { type: 'turn/start', seq: 4, data: {} } }]);
  assert.equal(v.projections.values.title, 'T');
  ws.push({ type: 'item', streamId: open.streamId, value: { type: 'event', event: { type: 'turn/end', seq: 6, data: {} } } });
  assert.equal(frames.at(-1).payload.event.type, 'turn/end');
  // A second follow cancels the first.
  const p2 = client.rpc('session.history', { sessionId: 's2', maxMessages: 24 });
  assert.deepEqual(ws.sent.find((m) => m.type === 'cancel'), { type: 'cancel', streamId: open.streamId });
  await assert.rejects(p2, /timed out/);
});

test('older history pages against the snapshot cursor', async () => {
  const { client, calls } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  const p = client.rpc('session.history', { sessionId: 's1', maxMessages: 24 });
  ws.push({ type: 'item', streamId: ws.sent.find((m) => m.endpoint === 'session/follow').streamId, value: { type: 'snapshot', cursor: 12, records: [], projections: {} } });
  await p;
  await client.rpc('session.history', { sessionId: 's1', beforeSeq: 4, maxMessages: 24 });
  assert.deepEqual(calls.at(-1), { endpoint: 'session/page', payload: { args: { request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 12, beforeSeq: 4, maxMessages: 24 } } }, rpcId: undefined });
});

test('answering an approval posts the outcome to $events/result with this stream\'s client id', async () => {
  const { client, calls, frames } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'ready', clientId: 'cid', host: {} } });
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's1', request: { toolName: 'bash' } } });
  ws.push({ type: 'item', streamId: 'ev', value: { type: 'waterfall', event: 'user-questions/request', eventId: 'e2', agentId: 's1', request: { questions: [] } } });
  await client.respond('e1', { ok: true, value: { sessionId: 's1', approvalId: 'e1', outcome: 'allowed-once' } });
  await client.respond('e2', { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'q', selected: ['A'] }] } } });
  await client.respond('e2', { ok: false, error: { code: 'cancelled', message: 'Skipped from mobile' } });
  assert.deepEqual(calls.map((c) => c.payload.args), [
    { clientId: 'cid', eventId: 'e1', outcome: { kind: 'result', value: 'allowed-once' } },
    { clientId: 'cid', eventId: 'e2', outcome: { kind: 'result', value: { answers: [{ id: 'q', selected: ['A'] }] } } },
    { clientId: 'cid', eventId: 'e2', outcome: { kind: 'rejected', error: { name: 'Error', message: 'Skipped from mobile', code: 'cancelled' } } },
  ]);
  assert.ok(calls.every((c) => c.endpoint === '$events/result'));
  assert.deepEqual(frames.filter((f) => /resolved/.test(f.payload.type)).map((f) => f.payload.type), ['approval/resolved', 'question/resolved']);
});

test('answering with no feed fails instead of posting a guess', async () => {
  const { client } = harness();
  await assert.rejects(client.respond('e1', { ok: true, value: {} }), /not connected/);
});

test('a failed core feed closes the socket so the page reconnects', () => {
  const { client, frames, state } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  ws.readyState = 1;
  ws.push({ type: 'error', streamId: 'ctl', error: { code: 'gateway/internal', message: 'control failed' } });
  assert.equal(frames.at(-1).payload.type, 'stream/error');
  assert.equal(state.down, 1);
});

test('goalOf reads the goal projection and a goals/get view, and nothing else', () => {
  const snap = { id: 'g1', revision: 3, objective: 'ship it', phase: 'blocked', blockedReason: { code: 'needs-input', message: 'need a key' }, maxGoalRounds: 10 };
  assert.deepEqual(goalOf({ goal: snap, roundsStarted: 4, createdAt: 1, updatedAt: 2 }),
    { ref: { id: 'g1', revision: 3 }, objective: 'ship it', phase: 'blocked', blocked: 'need a key', maxRounds: 10, rounds: 4, activation: undefined });
  assert.equal(goalOf({ ...snap, roundsStarted: 4, activation: 'armed' }).activation, 'armed');
  assert.equal(goalOf(null), null);
  assert.equal(goalOf(undefined), null);
  assert.equal(goalOf({ goal: { objective: 'x' } }), null);
});

test('goalStatus says when an active goal will not continue on its own', () => {
  const g = { phase: 'active', maxRounds: 256, rounds: 3, activation: 'armed' };
  assert.deepEqual(goalStatus(g), { glyph: '●', level: 'active', text: 'active · 3/256 rounds' });
  assert.equal(goalStatus({ ...g, activation: 'disarmed' }).text, 'active, not continuing · 3/256 rounds');
  assert.equal(goalStatus({ ...g, phase: 'blocked' }).level, 'err');
  assert.equal(goalStatus({ ...g, phase: 'complete', maxRounds: null }).text, 'complete · 3 rounds');
});

test('goal calls pass their arguments by declared name', async () => {
  const { client, calls } = harness();
  const ref = { id: 'g1', revision: 2 };
  await client.remote('goals/get', { agentId: 's' });
  await client.remote('goals/create', { agentId: 's', request: { objective: 'x', maxGoalRounds: 5 } });
  await client.remote('goals/edit', { agentId: 's', ref, request: { objective: 'y' } });
  await client.remote('goals/pause', { agentId: 's', ref });
  assert.deepEqual(calls.map((c) => [c.endpoint, c.payload.args]), [
    ['goals/get', { agentId: 's' }],
    ['goals/create', { agentId: 's', request: { objective: 'x', maxGoalRounds: 5 } }],
    ['goals/edit', { agentId: 's', ref, request: { objective: 'y' } }],
    ['goals/pause', { agentId: 's', ref }],
  ]);
});

test('tool call views are rebuilt from the arguments, as dsh 0.2\'s web client does', () => {
  assert.deepEqual(toolCallView('bash', JSON.stringify({ command: 'npm test', description: 'Run tests', workdir: 'pkg' })),
    { card: 'terminal', title: 'npm test', description: 'Run tests', cwd: 'pkg' });
  assert.deepEqual(toolCallView('bash', { command: 'ls' }), { card: 'terminal', title: 'ls' }); // the persistent shell
  assert.equal(toolCallView('bash', { command: 'sleep 9', description: 'd', run_in_background: true }), null);
  assert.deepEqual(toolCallView('edit', JSON.stringify({ file_path: 'a.js', old_string: 'x', new_string: 'y' })),
    { card: 'diff', title: 'Edit a.js', diffs: [{ path: 'a.js', oldText: 'x', newText: 'y' }] });
  assert.deepEqual(toolCallView('write', { file_path: 'b.txt', content: 'hi' }),
    { card: 'diff', title: 'Write b.txt', diffs: [{ path: 'b.txt', oldText: null, newText: 'hi' }] });
  assert.deepEqual(toolCallView('str_replace_editor', { command: 'create', path: 'c.md', file_text: '# c' }).diffs, [{ path: 'c.md', oldText: null, newText: '# c' }]);
  assert.deepEqual(toolCallView('read', { file_path: 'a.js' }),
    { card: 'generic', title: 'Read a.js', kind: 'read', locations: [{ path: 'a.js', line: 1 }] });
  assert.deepEqual(toolCallView('read', { file_path: 'a.js', offset: 5, limit: 3 }),
    { card: 'generic', title: 'Read a.js (5 - 7)', kind: 'read', locations: [{ path: 'a.js', line: 5 }] });
  assert.deepEqual(toolCallView('grep', { pattern: 'TODO', path: 'src', include: '*.js' }),
    { card: 'generic', title: 'Grep TODO in src (*.js)', kind: 'search', rawInput: 'TODO' });
  assert.deepEqual(toolCallView('glob', { pattern: '*.md' }),
    { card: 'generic', title: 'Glob *.md', kind: 'search', rawInput: '*.md' });
  assert.deepEqual(toolCallView('web_search', { queries: ['node 22', 'lts'] }),
    { card: 'generic', title: 'node 22, lts', kind: 'search', rawInput: 'node 22, lts' });
  assert.deepEqual(toolCallView('web_fetch', { url: 'https://example.com/' }),
    { card: 'generic', title: 'https://example.com/', kind: 'fetch', rawInput: 'https://example.com/' });
  assert.deepEqual(toolCallView('todo_write', FIXTURES.todo_write.arguments),
    { card: 'todos', todos: FIXTURES.todo_write.arguments.todos });
  assert.equal(toolCallView('read', { file_path: '' }), null);
  assert.equal(toolCallView('grep', { pattern: '' }), null);
  assert.equal(toolCallView('web_search', { queries: [] }), null);
  assert.equal(toolCallView('web_fetch', {}), null);
  assert.equal(toolCallView('edit', '{not json'), null);
  assert.equal(toolCallView('write', { file_path: '', content: 'x' }), null);
});

test('tool result views read dsh-shell\'s exit markers and dsh-tool-fs\'s applied hunks', () => {
  const text = (t) => [{ type: 'text', text: t }];
  const sh = { command: 'make', description: 'Build' };
  assert.deepEqual(toolResultView('bash', sh, { content: text('built') }), { card: 'terminal', output: 'built', exitCode: 0 });
  assert.deepEqual(toolResultView('bash', sh, { content: text('oops\n[exit code: 2]') }), { card: 'terminal', output: 'oops', exitCode: 2 });
  assert.deepEqual(toolResultView('pwsh', sh, { content: text('x\n[killed by signal: SIGTERM]') }), { card: 'terminal', output: 'x', signal: 'SIGTERM' });
  // A spilled result can hide the marker: no exit status is inferred.
  const spill = 'head\n\n(Omitted 10 bytes. Full formatted result stored at: /tmp/x. Read it.)';
  assert.deepEqual(toolResultView('bash', sh, { content: text(spill) }), { card: 'terminal', output: spill });
  // The persistent shell's own marker.
  assert.deepEqual(toolResultView('bash', { command: 'ls' }, { content: text('a\n[Command finished with exit code 1]') }), { card: 'terminal', output: 'a', exitCode: 1 });
  assert.deepEqual(toolResultView('bash', { command: 'ls' }, { content: text('a') }), { card: 'terminal', output: 'a' });
  // An errored command keeps its output but claims no exit code; a marker still counts.
  assert.deepEqual(toolResultView('bash', sh, { content: text('denied'), isError: true }), { card: 'terminal', output: 'denied' });
  assert.deepEqual(toolResultView('bash', sh, { content: text('boom\n[exit code: 2]'), isError: true }), { card: 'terminal', output: 'boom', exitCode: 2 });
  // A command that printed nothing: the marker is the whole result.
  assert.deepEqual(toolResultView('bash', sh, { content: text('[exit code: 1]') }), { card: 'terminal', output: '', exitCode: 1 });
  assert.equal(toolResultView('bash', sh, { content: [] }), null);

  const hunk = { path: 'a.js', oldText: 'x\n', newText: 'y\n' };
  const edit = { file_path: 'a.js', old_string: 'x', new_string: 'y' };
  assert.deepEqual(toolResultView('edit', edit, { content: text('ok'), meta: { diffs: [hunk] } }), { card: 'diff', diffs: [hunk] });
  assert.deepEqual(toolResultView('edit', edit, { content: text('ok') }), { card: 'generic' });
  assert.deepEqual(toolResultView('edit', edit, { content: text('ok'), meta: { diffs: [{ path: 1 }] } }), { card: 'generic' });
  assert.equal(toolResultView('edit', edit, { content: text('no match'), isError: true, meta: { diffs: [hunk] } }), null);
  const write = { file_path: 'b.txt', content: 'hi' };
  assert.deepEqual(toolResultView('write', write, { content: text('ok'), meta: { diffs: [], operation: 'create' } }), { card: 'diff', diffs: [{ path: 'b.txt', oldText: null, newText: 'hi' }] });
  assert.deepEqual(toolResultView('str_replace_editor', { command: 'create', path: 'c', file_text: '' }, { content: text('ok') }), { card: 'generic' });
  assert.equal(toolResultView('read', { file_path: 'a.js' }, { content: text('...') }), null);
  assert.equal(toolResultView(undefined, undefined, { content: text('orphan') }), null);
});

test('read, search and web result views are rebuilt from the tool-private meta', () => {
  const f = FIXTURES;
  const read = toolResultView('read', f.read.arguments, resultOf(f.read));
  assert.deepEqual(read, { card: 'read', path: 'src/app.js', offset: 10, lines: f.read.result.meta.lines, totalLines: 42, lang: 'js' });
  // A whole-file read carries no language hint.
  assert.deepEqual(toolResultView('read', f.read_whole.arguments, resultOf(f.read_whole)),
    { card: 'read', path: 'notes.md', offset: 1, lines: f.read_whole.result.meta.lines, totalLines: 3 });

  assert.deepEqual(toolResultView('grep', f.grep.arguments, resultOf(f.grep)),
    { card: 'search', shape: 'matches', files: f.grep.result.meta.files, truncated: false, total: 3 });
  assert.deepEqual(toolResultView('glob', f.glob.arguments, resultOf(f.glob)),
    { card: 'search', shape: 'paths', paths: ['docs/README.md', 'docs/guide.md', 'docs/faq.md'], truncated: true, total: 12 });

  assert.deepEqual(toolResultView('web_search', f.web_search.arguments, resultOf(f.web_search)),
    { card: 'web', kind: 'search', title: 'node 22 lts, node release schedule', sources: f.web_search.result.meta.sources, truncated: true, answer: 'Node 22 is the current LTS.' });
  assert.deepEqual(toolResultView('web_fetch', f.web_fetch.arguments, resultOf(f.web_fetch)),
    { card: 'web', kind: 'fetch', title: 'https://example.com/docs', url: 'https://example.com/docs', statusCode: 200, truncated: false });

  // No meta, a malformed one, or an error keeps the raw result on the generic row.
  const text = (t) => [{ type: 'text', text: t }];
  assert.equal(toolResultView('read', f.read.arguments, { content: text('x'), isError: false }), null);
  assert.equal(toolResultView('grep', f.grep.arguments, { content: text('x'), isError: false }), null);
  assert.equal(toolResultView('read', f.read.arguments, { content: text('x'), isError: true, meta: f.read.result.meta }), null);
  assert.equal(toolResultView('web_fetch', f.web_fetch.arguments, { content: text('x'), isError: false }), null);
});

test('malformed read, search and web meta falls back to the generic row', () => {
  const m = FIXTURES.malformed;
  assert.equal(toolResultView('read', {}, { isError: false, meta: m.read_offset.meta }), null);
  assert.equal(toolResultView('read', {}, { isError: false, meta: m.read_number_gap.meta }), null);
  assert.equal(toolResultView('grep', {}, { isError: false, meta: m.grep_truncated_flag.meta }), null);
  assert.equal(toolResultView('glob', {}, { isError: false, meta: m.glob_path_number.meta }), null);
  assert.equal(toolResultView('web_search', {}, { isError: false, meta: m.web_search_source.meta }), null);
  assert.equal(toolResultView('web_fetch', {}, { isError: false, meta: m.web_fetch_status.meta }), null);
});

test('todosFrom reads the call view (0.1) or the raw argument (0.2), and rejects a bad list', () => {
  const todos = FIXTURES.todo_write.arguments.todos;
  assert.deepEqual(todosFrom('todo_write', FIXTURES.todo_write.arguments), todos);
  assert.deepEqual(todosFrom('todo_write', JSON.stringify(FIXTURES.todo_write.arguments)), todos);
  assert.deepEqual(todosFrom('todo_write', null, { rawInput: todos }), todos);
  assert.deepEqual(todosFrom('todo_write', null, { rawInput: [] }), []);
  assert.equal(todosFrom('read', FIXTURES.todo_write.arguments), null);
  assert.equal(todosFrom('todo_write', { todos: [{ content: '', status: 'pending' }] }), null);
  assert.equal(todosFrom('todo_write', { todos: [{ content: 'x', status: 'done' }] }), null);
});

test('watchJobs opens one job/list stream per session and reconciles the set', () => {
  const { client } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  client.watchJobs(['s1', 's2']);
  const opens = ws.sent.filter((m) => m.endpoint === 'job/list');
  assert.deepEqual(opens.map((m) => m.payload.args), [{ request: { sessionId: 's1' } }, { request: { sessionId: 's2' } }]);
  client.watchJobs(['s2', 's3']);
  const cancelled = ws.sent.filter((m) => m.type === 'cancel');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].streamId, opens.find((m) => m.payload.args.request.sessionId === 's1').streamId);
  assert.equal(ws.sent.filter((m) => m.endpoint === 'job/list' && m.payload.args.request.sessionId === 's3').length, 1);
  // Watching the same set again is a no-op.
  client.watchJobs(['s2', 's3']);
  assert.equal(ws.sent.filter((m) => m.endpoint === 'job/list').length, 3);
});

test('a job/list frame reaches the page as session/jobs and a failure only clears that session', () => {
  const { client, frames, state } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  client.watchJobs(['s1']);
  const jl = ws.sent.find((m) => m.endpoint === 'job/list');
  ws.push({ type: 'item', streamId: jl.streamId, value: { type: 'rows', jobs: [{ id: 'bash-1', kind: 'bash', label: 'run', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }] } });
  assert.deepEqual(frames.at(-1).payload, { type: 'session/jobs', sessionId: 's1', jobs: [{ id: 'bash-1', kind: 'bash', label: 'run', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }] });
  ws.readyState = 1;
  ws.push({ type: 'error', streamId: jl.streamId, error: { code: 'gateway/internal', message: 'gone' } });
  assert.deepEqual(frames.at(-1).payload, { type: 'session/jobs', sessionId: 's1', jobs: [] });
  assert.equal(state.down, 0, 'a job stream failing does not take the feed down');
  // A later watch retries the roster on the same socket.
  client.watchJobs(['s1']);
  assert.equal(ws.sent.filter((m) => m.endpoint === 'job/list').length, 2);
});

test('killJob posts job/kill for a session that can see the job', async () => {
  const { client, calls } = harness();
  const v = await client.killJob('s1', 'bash-1');
  assert.deepEqual(v, { echoed: 'job/kill' });
  assert.deepEqual(calls.at(-1), { endpoint: 'job/kill', payload: { args: { request: { sessionId: 's1', jobId: 'bash-1' } } }, rpcId: undefined });
});

test('observeJob follows one job on demand, cancels on collapse, and reopens after a reconnect', () => {
  const { client, frames } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  client.observeJob('s1', 'bash-1');
  const open = ws.sent.find((m) => m.endpoint === 'job/follow');
  assert.deepEqual(open.payload.args, { request: { sessionId: 's1', jobId: 'bash-1' } });
  ws.push({ type: 'item', streamId: open.streamId, value: { type: 'opened', job: { id: 'bash-1', status: 'running' }, from: 0 } });
  ws.push({ type: 'item', streamId: open.streamId, value: { type: 'output', chunks: [{ at: 0, text: 'hi' }], next: 2 } });
  ws.push({ type: 'item', streamId: open.streamId, value: { type: 'status', job: { id: 'bash-1', status: 'completed', detail: 'exit code: 0' } } });
  assert.deepEqual(frames.filter((f) => f.payload.type === 'job/output').map((f) => f.payload.kind), ['opened', 'output', 'status']);
  client.observeJob('s1', 'bash-1');
  assert.equal(ws.sent.filter((m) => m.endpoint === 'job/follow').length, 1, 'the same job is followed once');
  client.stopObserve('bash-1');
  assert.ok(ws.sent.some((m) => m.type === 'cancel' && m.streamId === open.streamId));
  // A new socket restores the rosters and the output reads the page still wants.
  client.watchJobs(['s1']);
  client.observeJob('s1', 'bash-2');
  ws.close();
  client.connect();
  const ws2 = FakeSocket.last;
  ws2.open();
  assert.ok(ws2.sent.some((m) => m.endpoint === 'job/list' && m.payload.args.request.sessionId === 's1'));
  assert.ok(ws2.sent.some((m) => m.endpoint === 'job/follow' && m.payload.args.request.jobId === 'bash-2'));
  assert.equal(ws2.sent.some((m) => m.endpoint === 'job/follow' && m.payload.args.request.jobId === 'bash-1'), false, 'a collapsed read is not restored');
});

test('a job/follow end closes the output after an early stream end', () => {
  const { client, frames } = harness();
  client.connect();
  const ws = FakeSocket.last;
  ws.open();
  client.observeJob('s1', 'bash-1');
  const open = ws.sent.find((m) => m.endpoint === 'job/follow');
  ws.push({ type: 'end', streamId: open.streamId });
  assert.deepEqual(frames.at(-1).payload, { type: 'job/output', sessionId: 's1', jobId: 'bash-1', kind: 'end' });
});
