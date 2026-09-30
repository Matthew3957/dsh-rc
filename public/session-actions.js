// Pure helpers behind the session menu's Fork, Export and Archive actions.
//
// dsh's own schemas define all three:
//   - session.fork ({sessionId, atSeq?}) -> {sessionId} of the child. Without atSeq it cuts at the
//     source's last completed turn; a session with none answers `fork-unavailable`.
//   - GET /api/session.export?sessionId=&includeDescendants=true -> a ZIP of the session log.
//   - workspace.archiveSession ({sessionId}) -> {archivedSessionIds}, the full set. dsh has no
//     unarchive method, and session.list keeps returning archived rows, so the page hides them
//     itself using the set from workspace.list and the host/archived-sessions-changed frame.

/** URL of the session-log ZIP. Absolute like the RPC calls: the page shares dsh's origin. */
export function exportUrl(sessionId, { includeDescendants = false } = {}) {
  const q = new URLSearchParams({ sessionId });
  // dsh accepts exactly "true" or "false" and rejects anything else.
  if (includeDescendants) q.set('includeDescendants', 'true');
  return '/api/session.export?' + q.toString();
}

/** File name from a Content-Disposition header, or a fallback. */
export function exportFilename(disposition, sessionId) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || '');
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return `dsh-session-${sessionId}.zip`;
}

/** The archive set as a Set, from either RPC value or frame payload. Tolerates absence. */
export function archiveSet(ids) {
  return new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []);
}

/** Session rows that are not archived. */
export function visibleSessions(sessions, archived) {
  return (sessions || []).filter((s) => !archived.has(s.sessionId));
}

/** A phone-sized sentence for a failed fork. */
export function forkFailure(err) {
  if (err && err.code === 'fork-unavailable') {
    return 'Nothing to fork yet: the session needs at least one finished turn.';
  }
  return 'Fork failed: ' + ((err && err.message) || 'unknown error');
}

// app.js is a classic script and cannot import this module, so hand it the
// functions. Absent in Node, where the tests import the file directly.
if (typeof window !== 'undefined') {
  window.dshActions = { exportUrl, exportFilename, archiveSet, visibleSessions, forkFailure };
}
