import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exportUrl, exportFilename, archiveSet, visibleSessions, forkFailure } from '../public/session-actions.js';

test('exportUrl names the session and only sends includeDescendants=true', () => {
  assert.equal(exportUrl('session-1'), '/api/session.export?sessionId=session-1');
  assert.equal(exportUrl('session-1', { includeDescendants: true }), '/api/session.export?sessionId=session-1&includeDescendants=true');
  assert.equal(exportUrl('a b&c'), '/api/session.export?sessionId=a+b%26c');
});

test('exportFilename reads the header and falls back', () => {
  assert.equal(exportFilename('attachment; filename="dsh-session-x.zip"', 'x'), 'dsh-session-x.zip');
  assert.equal(exportFilename(null, 'x'), 'dsh-session-x.zip');
});

test('archiveSet tolerates a missing or malformed list', () => {
  assert.deepEqual([...archiveSet(['a', 'b', 3])], ['a', 'b']);
  assert.equal(archiveSet(undefined).size, 0);
});

test('visibleSessions hides archived rows only', () => {
  const rows = [{ sessionId: 'a' }, { sessionId: 'b' }];
  assert.deepEqual(visibleSessions(rows, new Set(['a'])), [{ sessionId: 'b' }]);
  assert.deepEqual(visibleSessions(rows, new Set()), rows);
});

test('forkFailure explains fork-unavailable and keeps other messages', () => {
  assert.match(forkFailure({ code: 'fork-unavailable' }), /finished turn/);
  assert.equal(forkFailure(new Error('boom')), 'Fork failed: boom');
});
