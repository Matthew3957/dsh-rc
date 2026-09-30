// Pure event -> notification mapping for the dsh-rc watcher.
//
// The watcher feeds every frame from dsh's /api/events.mux and /api/events.host
// sockets through `createNotifier().handle(frame)`. Everything that decides
// whether a frame becomes a notification lives here, with no I/O, so it can be
// tested directly. The payload shape is the one public/sw.js renders:
// { title, body, sessionId, tag }.

/** Repeat notifications with the same tag inside this window are dropped. */
export const DEBOUNCE_MS = 5000;

function projectionTitle(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.title === 'string') return value.title;
  return null;
}

function firstQuestionText(questions) {
  const first = Array.isArray(questions) ? questions[0] : null;
  if (!first || typeof first !== 'object') return '';
  const text = first.question || first.header;
  return typeof text === 'string' ? text : '';
}

// A plan-mode review (a question tagged `intent.kind: 'plan-review'`, the plan
// markdown in `detail`): the plan's first heading, '' when it has none, or null
// when this is an ordinary question.
function planHeading(questions) {
  const first = Array.isArray(questions) && questions.length === 1 ? questions[0] : null;
  if (!first || !first.intent || first.intent.kind !== 'plan-review' || typeof first.detail !== 'string') return null;
  const m = /^#{1,6}\s+(.+?)\s*$/m.exec(first.detail);
  return m ? m[1] : '';
}

function notification(kind, title, detail, sessionId, sessionTitle) {
  const body = [sessionTitle, detail].filter((s) => typeof s === 'string' && s.trim()).join(' · ');
  const sid = typeof sessionId === 'string' && sessionId ? sessionId : null;
  return { kind, title, body, sessionId: sid, tag: sid ? `${kind}:${sid}` : kind };
}

/**
 * Map one frame envelope to a notification, or null when the frame should stay
 * silent. Pure: all outside knowledge arrives through `ctx`.
 *
 * ctx.sessionTitle  title of the session, when known
 * ctx.subagent      true when the session is a subagent (never notified)
 * ctx.runningBefore previous running value for host/session-status
 */
export function mapFrame(frame, ctx = {}) {
  const p = frame && frame.payload;
  if (!p || typeof p !== 'object') return null;
  if (ctx.subagent) return null;
  const sessionTitle = typeof ctx.sessionTitle === 'string' ? ctx.sessionTitle : '';

  switch (p.type) {
    case 'approval/requested': {
      const detail = [p.toolName, p.reason]
        .filter((s) => typeof s === 'string' && s.trim())
        .join(': ');
      return notification('approval', 'Approval needed', detail, p.sessionId, sessionTitle);
    }
    case 'question/requested': {
      const plan = planHeading(p.questions);
      if (plan !== null) return notification('question', 'Plan ready for review', plan, p.sessionId, sessionTitle);
      return notification('question', 'Question waiting', firstQuestionText(p.questions), p.sessionId, sessionTitle);
    }
    case 'host/session-status':
      if (p.running === false && ctx.runningBefore === true) {
        return notification('finished', 'Turn finished', '', p.sessionId, sessionTitle);
      }
      return null;
    case 'host/agent-error':
      return notification('error', 'Error', typeof p.message === 'string' ? p.message : '', p.sessionId, sessionTitle);
    case 'stream/error': {
      const message = p.error && typeof p.error.message === 'string' ? p.error.message : '';
      // stream/error is a transport-level frame and carries no sessionId.
      return notification('error', 'Error', message, p.sessionId, sessionTitle);
    }
    default:
      return null;
  }
}

/**
 * Stateful wrapper around `mapFrame`: remembers subagent lineage, session
 * titles, running flips and recent notification tags. `now` is injectable so
 * the debounce window is testable.
 */
export function createNotifier({ now = () => Date.now() } = {}) {
  const parents = new Set();
  const titles = new Map();
  const running = new Map();
  const lastSent = new Map();

  function handle(frame) {
    const p = frame && frame.payload;
    if (!p || typeof p !== 'object') return null;

    // Bookkeeping frames: learn lineage and titles, never notify.
    if (p.type === 'host/session-added') {
      if (typeof p.sessionId === 'string' && typeof p.parentSessionId === 'string' && p.parentSessionId) {
        parents.add(p.sessionId);
      }
      return null;
    }
    if (p.type === 'session/projection') {
      if (p.key === 'title' && typeof p.sessionId === 'string') {
        const t = projectionTitle(p.value);
        if (t) titles.set(p.sessionId, t);
      }
      return null;
    }
    if (p.type === 'session/event') {
      if (p.event && p.event.type === 'session/title' && typeof p.sessionId === 'string') {
        const t = p.event.data && p.event.data.title;
        if (typeof t === 'string' && t) titles.set(p.sessionId, t);
      }
      return null;
    }

    const sid = p.sessionId;
    const wasRunning = running.get(sid);
    if (p.type === 'host/session-status') running.set(sid, !!p.running);

    const n = mapFrame(frame, {
      sessionTitle: titles.get(sid),
      subagent: typeof sid === 'string' && parents.has(sid),
      runningBefore: wasRunning,
    });
    if (!n) return null;

    const t = now();
    const prev = lastSent.get(n.tag);
    if (prev != null && t - prev < DEBOUNCE_MS) return null;
    lastSent.set(n.tag, t);
    return n;
  }

  return {
    handle,
    isSubagent: (sessionId) => parents.has(sessionId),
    titleFor: (sessionId) => titles.get(sessionId) ?? null,
  };
}
