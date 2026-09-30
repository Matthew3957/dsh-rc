import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNotifier, mapFrame, DEBOUNCE_MS } from '../server/notify.mjs';

const SID = 'session-0000';
const frame = (payload) => ({ payload });

test('mapFrame: approval/requested uses the tool name and reason', () => {
  const n = mapFrame(frame({ type: 'approval/requested', sessionId: SID, approvalId: 'a1', toolName: 'Bash', reason: 'runs a command' }), {});
  assert.equal(n.title, 'Approval needed');
  assert.equal(n.body, 'Bash: runs a command');
  assert.equal(n.sessionId, SID);
  assert.equal(n.tag, 'approval:' + SID);
});

test('mapFrame: approval/requested works without a reason', () => {
  const n = mapFrame(frame({ type: 'approval/requested', sessionId: SID, approvalId: 'a1', toolName: 'Edit' }), {});
  assert.equal(n.body, 'Edit');
});

test('mapFrame: question/requested carries the first question', () => {
  const n = mapFrame(frame({ type: 'question/requested', sessionId: SID, questions: [{ id: 'q1', question: 'Which branch?' }] }), {});
  assert.equal(n.title, 'Question waiting');
  assert.equal(n.body, 'Which branch?');
  assert.equal(n.tag, 'question:' + SID);
});

test('mapFrame: host/session-status notifies only on running true -> false', () => {
  assert.equal(mapFrame(frame({ type: 'host/session-status', sessionId: SID, running: true }), { runningBefore: false }), null);
  assert.equal(mapFrame(frame({ type: 'host/session-status', sessionId: SID, running: false }), {}), null);
  const n = mapFrame(frame({ type: 'host/session-status', sessionId: SID, running: false }), { runningBefore: true });
  assert.equal(n.title, 'Turn finished');
  assert.equal(n.tag, 'finished:' + SID);
});

test('mapFrame: host/agent-error and stream/error carry the message', () => {
  const agent = mapFrame(frame({ type: 'host/agent-error', sessionId: SID, message: 'model exploded' }), {});
  assert.equal(agent.title, 'Error');
  assert.equal(agent.body, 'model exploded');
  assert.equal(agent.tag, 'error:' + SID);

  const stream = mapFrame(frame({ type: 'stream/error', error: { message: 'mux went away' } }), {});
  assert.equal(stream.title, 'Error');
  assert.equal(stream.body, 'mux went away');
  assert.equal(stream.sessionId, null);
  assert.equal(stream.tag, 'error');
});

test('mapFrame: irrelevant frames stay silent', () => {
  assert.equal(mapFrame(frame({ type: 'session/subscribed', sessionId: SID, lastSeq: 1 }), {}), null);
  assert.equal(mapFrame(frame({ type: 'approval/resolved', sessionId: SID }), {}), null);
  assert.equal(mapFrame(undefined, {}), null);
});

test('mapFrame: a subagent context is never notified', () => {
  const n = mapFrame(frame({ type: 'approval/requested', sessionId: SID, toolName: 'Bash' }), { subagent: true });
  assert.equal(n, null);
});

test('notifier: the session title lands in the body', () => {
  const notifier = createNotifier();
  notifier.handle(frame({ type: 'session/projection', sessionId: SID, key: 'title', value: { title: 'Fix the parser' } }));
  const n = notifier.handle(frame({ type: 'approval/requested', sessionId: SID, approvalId: 'a', toolName: 'Bash' }));
  assert.equal(n.body, 'Fix the parser · Bash');

  const other = 'session-1111';
  notifier.handle(frame({ type: 'session/event', sessionId: other, event: { type: 'session/title', data: { title: 'Ship it' } } }));
  const m = notifier.handle(frame({ type: 'question/requested', sessionId: other, questions: [{ id: 'q', question: 'Now?' }] }));
  assert.equal(m.body, 'Ship it · Now?');
  assert.equal(notifier.titleFor(other), 'Ship it');
});

test('notifier: subagents announced by host/session-added are ignored', () => {
  const notifier = createNotifier();
  notifier.handle(frame({ type: 'host/session-added', sessionId: 'child', parentSessionId: 'root', blank: true }));
  assert.equal(notifier.isSubagent('child'), true);
  assert.equal(notifier.handle(frame({ type: 'approval/requested', sessionId: 'child', approvalId: 'a', toolName: 'Bash' })), null);
  const root = notifier.handle(frame({ type: 'approval/requested', sessionId: 'root', approvalId: 'b', toolName: 'Bash' }));
  assert.equal(root.sessionId, 'root');
});

test('notifier: debounces an identical notification inside the window', () => {
  let now = 1000;
  const notifier = createNotifier({ now: () => now });
  const event = frame({ type: 'approval/requested', sessionId: SID, approvalId: 'a', toolName: 'Bash' });
  assert.ok(notifier.handle(event));
  assert.equal(notifier.handle(event), null);
  now += DEBOUNCE_MS - 1;
  assert.equal(notifier.handle(event), null);
  now += 1;
  assert.ok(notifier.handle(event));
});

test('notifier: different kinds in the same session are separate tags', () => {
  const notifier = createNotifier();
  assert.ok(notifier.handle(frame({ type: 'approval/requested', sessionId: SID, approvalId: 'a', toolName: 'Bash' })));
  assert.ok(notifier.handle(frame({ type: 'question/requested', sessionId: SID, questions: [{ id: 'q', question: 'Well?' }] })));
});

test('notifier: tracks the running flip end to end', () => {
  const notifier = createNotifier();
  assert.equal(notifier.handle(frame({ type: 'host/session-status', sessionId: SID, running: true })), null);
  const n = notifier.handle(frame({ type: 'host/session-status', sessionId: SID, running: false }));
  assert.equal(n.title, 'Turn finished');
});
