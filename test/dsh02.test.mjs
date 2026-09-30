import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bareCode, createClient, fromControl, fromEvents, fromFollow, fromPluginInventory, fromWorkspace, goalOf, goalStatus, inboxToQueue, liveChunksOf, localizedText } from '../public/dsh02.js';
import { createNotifier } from '../server/notify.mjs';

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
