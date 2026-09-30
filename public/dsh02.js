// dsh 0.2 support: one adapter that lets the page (and the push watcher) keep speaking the
// shapes they were written for, on top of dsh 0.2's wire.
//
// What changed in dsh 0.2, from its generated contracts (`typert.remote-client.d.ts` in
// dsh-api-session-controller, dsh-api-workspace-controller, dsh-agent-preset-registry,
// dsh-commands and dsh-api-gateway's stream-protocol):
//   - Calls are `POST /api/<namespace>/<method>` with `{type: 'client-request', rpcId, method,
//     payload: {args}}`. `args` carries every parameter by its declared name, so a method that
//     takes one `request` object wants `{request: {...}}`.
//   - Live data is one WebSocket, `/api/remote.mux`, carrying logical streams. The page sends
//     `{type: 'open', streamId, endpoint, payload: {args}}` and gets `{type: 'item', streamId,
//     value}`, then `{type: 'error', streamId, error}` or `{type: 'end', streamId}`.
//   - `$events` (opened with empty args) is the Host's event feed: a `ready` item with the
//     clientId, `emit` items for `api-session/*` events, and `waterfall` items for the two
//     questions a person answers, `approval/request` and `user-questions/request`. A waterfall
//     stays pending until some client answers it by POSTing `$events/result`
//     (`{clientId, eventId, outcome}`), or dsh cancels it.
//   - `session/control` is the host-wide projection feed, `workspace/follow` the workspace and
//     archive feed, `session/follow` one session's snapshot, durable events and live assistant
//     chunks.
//
// The page's renderer and the watcher's notifier already read dsh 0.1's frames
// (`session/event`, `approval/requested`, `host/session-status`, ...). The `from*` functions here
// turn 0.2 items into those frames, and `createClient` maps the 0.1 method names the page calls
// onto 0.2 endpoints. `fromPluginInventory` does the same for `pluginInventory/list`, whose call
// is already `pluginInventory/list` on both APIs but whose 0.2 snapshot carries display metadata
// and agent-preset compositions the 0.1 snapshot lacks. Everything is pure or takes its I/O as
// arguments, so the tests run it in Node and the server's watcher shares it.

export const MUX_PATH = '/api/remote.mux';

const obj = (v) => (v && typeof v === 'object' ? v : {});
const str = (v) => (typeof v === 'string' ? v : undefined);

function reasonOf(req) {
  const r = str(req.reason);
  if (r) return r;
  const d = obj(req.displayReason);
  return str(d.en);
}

/**
 * One `$events` item as 0.1-shaped frames: `[{kind: 'mux' | 'host', payload, env?}]`. `pending` maps
 * a waterfall's eventId to its kind, so a later `cancel` item can say what was resolved.
 */
export function fromEvents(item, pending = new Map()) {
  const v = obj(item);
  if (v.type === 'emit') {
    const a = Array.isArray(v.args) ? v.args : [];
    switch (v.event) {
      case 'api-session/added': {
        const s = obj(a[0]);
        return [{ kind: 'host', payload: { type: 'host/session-added', sessionId: s.sessionId, parentSessionId: s.parentSessionId, origin: s.origin, blank: !!s.blank, cwd: s.cwd, running: !!s.running } }];
      }
      case 'api-session/removed':
        return [{ kind: 'host', payload: { type: 'host/session-removed', sessionId: a[0] } }];
      case 'api-session/status':
        return [{ kind: 'host', payload: { type: 'host/session-status', sessionId: a[0], running: !!a[1] } }];
      case 'api-session/error':
        return [{ kind: 'host', payload: { type: 'host/agent-error', sessionId: a[0], message: str(a[1]) || 'Agent error' } }];
      default:
        return [];
    }
  }
  if (v.type === 'waterfall') {
    const req = obj(v.request);
    if (v.event === 'approval/request') {
      pending.set(v.eventId, 'approval');
      return [{ kind: 'mux', env: { rpcId: v.eventId }, payload: { type: 'approval/requested', sessionId: v.agentId, approvalId: v.eventId, callId: req.callId, toolName: req.toolName, reason: reasonOf(req) } }];
    }
    if (v.event === 'user-questions/request') {
      pending.set(v.eventId, 'question');
      const wait = obj(req.wait);
      return [{ kind: 'mux', env: { rpcId: v.eventId }, payload: { type: 'question/requested', sessionId: v.agentId, questions: req.questions, callId: wait.callId } }];
    }
    return [];
  }
  if (v.type === 'cancel') {
    const kind = pending.get(v.eventId);
    pending.delete(v.eventId);
    if (kind === 'approval') return [{ kind: 'mux', payload: { type: 'approval/resolved', approvalId: v.eventId } }];
    if (kind === 'question') return [{ kind: 'mux', payload: { type: 'question/resolved', questionRpcId: v.eventId } }];
  }
  return [];
}

/**
 * dsh 0.2's `inbox` projection (`{'next-turn': Message[], 'next-step': Message[]}`) as the queue
 * items the page lists. Only what a person typed is a queued message; runtime reminders are context.
 */
export function inboxToQueue(inbox) {
  const b = obj(inbox);
  const items = [];
  for (const [list, placement] of [['next-turn', 'queued'], ['next-step', 'steering']]) {
    for (const m of Array.isArray(b[list]) ? b[list] : []) {
      const source = obj(m).source;
      const user = source && source.kind === 'user';
      items.push({ id: m.id, message: m, placement: user ? placement : 'context' });
    }
  }
  return items;
}

/**
 * Display text from a `LocalizedText` (`string`, or `{en, <locale>: string}`). The page asks
 * for its own language and dsh sends literal fallbacks, so this picks the best one and never
 * invents text: an absent or empty value stays undefined.
 */
export function localizedText(text, locale) {
  if (typeof text === 'string') return text || undefined;
  if (!text || typeof text !== 'object') return undefined;
  const wanted = [];
  if (typeof locale === 'string') {
    const lower = locale.toLowerCase();
    wanted.push(lower, lower.split('-')[0]);
  }
  wanted.push('en');
  for (const lang of wanted) if (typeof text[lang] === 'string' && text[lang]) return text[lang];
  for (const value of Object.values(text)) if (typeof value === 'string' && value) return value;
  return undefined;
}

/**
 * A `pluginInventory/list` snapshot as the rows the page renders: every entry keeps the 0.1
 * fields (`entryId`, `moduleName`, `enabled`, `fiberPhase`) and gains the 0.2 display `meta`
 * resolved to `title`/`description`. The 0.2-only `agentPresets` and `managementAvailable`
 * come out beside them; a 0.1 snapshot simply has neither, so the page renders as before.
 */
export function fromPluginInventory(snapshot, { locale } = {}) {
  const b = obj(snapshot);
  const entry = (e) => {
    const row = obj(e);
    const meta = obj(row.meta);
    return {
      entryId: str(row.entryId),
      moduleName: str(row.moduleName) || '',
      enabled: row.enabled === true,
      fiberPhase: row.fiberPhase ?? null,
      title: localizedText(meta.title, locale),
      description: localizedText(meta.description, locale),
    };
  };
  const entries = (Array.isArray(b.entries) ? b.entries : Array.isArray(b.items) ? b.items : []).map(entry);
  const presets = (Array.isArray(b.agentPresets) ? b.agentPresets : []).map((p) => {
    const group = obj(p);
    const rows = (Array.isArray(group.rows) ? group.rows : []).map(entry);
    return {
      id: str(group.id) || '',
      name: str(group.name) || str(group.id) || '',
      isDefault: group.isDefault === true,
      broken: str(group.broken),
      rows,
      failed: rows.filter((r) => r.fiberPhase === 'failed').length,
    };
  });
  return { entries, presets, managementAvailable: b.managementAvailable === true };
}

function projectionFrames(sessionId, key, value, seq) {
  const out = [{ kind: 'mux', payload: { type: 'session/projection', sessionId, key, value, seq } }];
  if (key === 'inbox') out.push({ kind: 'mux', payload: { type: 'session/queue', sessionId, items: inboxToQueue(value) } });
  return out;
}

/** One `session/control` item. The baseline is every live session's complete projections. */
export function fromControl(item) {
  const v = obj(item);
  if (v.type === 'baseline') {
    const out = [];
    for (const [sessionId, block] of Object.entries(obj(obj(v.value).projections))) {
      const b = obj(block);
      for (const [key, value] of Object.entries(obj(b.values))) out.push(...projectionFrames(sessionId, key, value, typeof b.asOfSeq === 'number' ? b.asOfSeq : -1));
    }
    return out;
  }
  if (v.type === 'projection') return projectionFrames(v.sessionId, v.key, v.value, typeof v.seq === 'number' ? v.seq : -1);
  return [];
}

/** One `workspace/follow` item: the archive set is what the page reads from it. */
export function fromWorkspace(item) {
  const v = obj(item);
  if (v.type === 'baseline') return [{ kind: 'host', payload: { type: 'host/archived-sessions-changed', archivedSessionIds: obj(v.value).archivedSessionIds || [] } }];
  if (v.type === 'archived') return [{ kind: 'host', payload: { type: 'host/archived-sessions-changed', archivedSessionIds: v.archivedSessionIds || [] } }];
  return [];
}

/**
 * One `session/follow` item after the snapshot. Durable events become `session/event`; the live
 * assistant frames become transient `assistant/chunk` events (no seq: the page renders them at once
 * and the committed `assistant/message` replaces them). `attempts` remembers each attempt's turn and step.
 */
export function fromFollow(item, sessionId, attempts = new Map()) {
  const v = obj(item);
  if (v.type === 'event') return [{ kind: 'mux', payload: { type: 'session/event', sessionId, event: v.event } }];
  if (v.type !== 'assistant-stream') return [];
  const f = obj(v.frame);
  if (f.type === 'start') {
    attempts.set(f.attemptId, { turn: f.turn, step: f.step });
    return [];
  }
  if (f.type === 'end') {
    attempts.delete(f.attemptId);
    return [];
  }
  const at = attempts.get(f.attemptId);
  if (f.type !== 'chunk' || !at) return [];
  return [{ kind: 'mux', payload: { type: 'session/event', sessionId, transient: true, event: { type: 'assistant/chunk', data: { turn: at.turn, step: at.step, chunk: f.chunk } } } }];
}

/** The chunks of the attempt that was mid-flight when a snapshot was taken, as transient events. */
export function liveChunksOf(snapshot, sessionId) {
  const attempt = obj(obj(obj(snapshot).assistantStream).activeAttempt);
  if (!Array.isArray(attempt.stream)) return [];
  const out = [];
  for (const entry of attempt.stream) {
    const chunk = obj(entry).type === 'chunk' ? entry.chunk : entry;
    if (chunk && typeof chunk === 'object') out.push({ sessionId, transient: true, event: { type: 'assistant/chunk', data: { turn: attempt.turn, step: attempt.step, chunk } } });
  }
  return out;
}

/** dsh 0.2's error codes are namespaced (`session/fork-unavailable`); the page knows the bare form. */
export function bareCode(code) {
  return typeof code === 'string' ? code.replace(/^[^/]+\//, '') : code;
}

const toEvents = (sessionId, records) => (records || []).map((r) => ({ sessionId, event: r.event }));

/**
 * @param {object} o
 * @param {Function} o.transport  (endpoint, payload, rpcId) => value. Posts one client-request and
 *                                returns the result's value, or throws an Error with code/details.
 * @param {string} o.wsUrl        full ws(s):// URL of /api/remote.mux
 * @param {Function} [o.WebSocketImpl]
 * @param {Function} o.onFrame    (kind 'mux' | 'host', payload, env) for each 0.1-shaped frame
 * @param {Function} [o.onHome]   called with dsh's home directory when the event feed opens
 * @param {Function} [o.onUp]     called when the feed is established
 * @param {Function} [o.onDown]   called when the socket closed or a feed failed
 */
export function createClient({ transport, wsUrl, WebSocketImpl = globalThis.WebSocket, onFrame, onHome = () => {}, onUp = () => {}, onDown = () => {}, timeoutMs = 15000 }) {
  let ws = null;
  let clientId = null;
  let seqNo = 0;
  let follow = null; // {sessionId, streamId, attempts, snapshot(resolve, reject)}
  const pending = new Map(); // waterfall eventId -> 'approval' | 'question'
  const running = new Map();
  const cursors = new Map(); // sessionId -> the follow cursor, for session/page
  let workspace = null; // the last workspace baseline
  let workspaceWaiters = [];

  const call = (endpoint, args, rpcId) => transport(endpoint, { args }, rpcId);
  const emit = (frames) => {
    for (const f of frames) {
      if (f.kind === 'host' && f.payload.type === 'host/session-status') running.set(f.payload.sessionId, f.payload.running);
      onFrame(f.kind, f.payload, f.env || {});
    }
  };
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const open = (streamId, endpoint, args) => send({ type: 'open', streamId, endpoint, payload: { args } });

  function onItem(streamId, value) {
    if (streamId === 'ev') {
      if (value && value.type === 'ready') {
        clientId = value.clientId;
        onHome(obj(value.host).home);
        onUp();
        return;
      }
      emit(fromEvents(value, pending));
    } else if (streamId === 'ctl') {
      emit(fromControl(value));
    } else if (streamId === 'ws') {
      if (value && value.type === 'baseline') {
        workspace = obj(value.value);
        const waiters = workspaceWaiters; workspaceWaiters = [];
        for (const w of waiters) w(workspace);
      } else if (workspace && value && value.type === 'archived') workspace = { ...workspace, archivedSessionIds: value.archivedSessionIds };
      emit(fromWorkspace(value));
    } else if (follow && streamId === follow.streamId) {
      if (value && value.type === 'snapshot') {
        cursors.set(follow.sessionId, value.cursor);
        if (follow.snapshot) { const s = follow.snapshot; follow.snapshot = null; s.resolve(value); }
        return;
      }
      emit(fromFollow(value, follow.sessionId, follow.attempts));
    }
  }

  function fail(streamId, error) {
    if (follow && streamId === follow.streamId && follow.snapshot) {
      const s = follow.snapshot; follow.snapshot = null;
      s.reject(Object.assign(new Error(error && error.message || 'follow failed'), { code: bareCode(error && error.code) }));
      return;
    }
    if (streamId === 'ev' || streamId === 'ctl' || streamId === 'ws') {
      emit([{ kind: 'mux', payload: { type: 'stream/error', error: { message: (error && error.message) || `${streamId} stream failed` } } }]);
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  function connect() {
    close();
    const sock = new WebSocketImpl(wsUrl);
    ws = sock;
    sock.onopen = () => {
      open('ev', '$events', {});
      open('ctl', 'session/control', {});
      open('ws', 'workspace/follow', {});
      if (follow) open(follow.streamId, 'session/follow', { request: { address: { kind: 'session', sessionId: follow.sessionId }, assistantStream: true, maxMessages: 24 } });
    };
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'item') onItem(m.streamId, m.value);
      else if (m.type === 'error') fail(m.streamId, m.error);
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null; clientId = null; pending.clear();
      onDown();
    };
  }

  function close() {
    if (!ws) return;
    const sock = ws; ws = null; clientId = null; pending.clear();
    sock.onclose = null;
    try { sock.close(); } catch { /* already closed */ }
  }

  /** Follow one session and resolve with its opening snapshot. One session at a time. */
  function followSession(sessionId) {
    if (follow) send({ type: 'cancel', streamId: follow.streamId });
    const streamId = `f${++seqNo}`;
    const f = { sessionId, streamId, attempts: new Map(), snapshot: null };
    follow = f;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (f.snapshot) { f.snapshot = null; reject(new Error('session follow timed out')); } }, timeoutMs);
      f.snapshot = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      open(streamId, 'session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 24 } });
    });
  }

  function workspaceBaseline() {
    if (workspace) return Promise.resolve(workspace);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('workspace feed is not up')), timeoutMs);
      workspaceWaiters.push((w) => { clearTimeout(timer); resolve(w); });
    });
  }

  const address = (sessionId) => ({ kind: 'session', sessionId });

  async function history(p) {
    const sessionId = p.sessionId;
    if (p.beforeSeq != null) {
      const v = await call('session/page', { request: { address: address(sessionId), throughSeq: cursors.get(sessionId) ?? Number.MAX_SAFE_INTEGER, beforeSeq: p.beforeSeq, maxMessages: p.maxMessages } });
      return { events: toEvents(sessionId, v.records), hasMore: !!v.hasMore };
    }
    if (p.maxMessages === 1) {
      // The session list only wants a title, so read the projections without following.
      const v = await call('session/projections', { request: { sessionId } });
      return { events: [], hasMore: false, projections: v };
    }
    const snap = await followSession(sessionId);
    return {
      events: toEvents(sessionId, snap.records),
      hasMore: !!snap.hasMore,
      projections: snap.projections,
      cursor: snap.cursor,
      live: liveChunksOf(snap, sessionId),
    };
  }

  /** The 0.1 method names the page calls, on 0.2 endpoints. Results come back in the 0.1 shape. */
  const methods = {
    'session.list': async () => call('session/list', { _request: {} }),
    'session.history': history,
    'session.search': async (p) => call('session/search', { request: { query: p.query } }),
    'session.prompt': async (p, rpcId) => {
      const { sessionId, mode, content, clientTimeZone } = p;
      const request = { requestId: rpcId, sessionId, mode, content };
      if (clientTimeZone) request.clientTimeZone = clientTimeZone;
      return call('session/prompt', { request }, rpcId);
    },
    'session.cancel': async (p) => call('session/cancel', { request: { sessionId: p.sessionId } }),
    'session.updateQueue': async (p) => call('session/updateQueue', { request: { sessionId: p.sessionId, itemId: p.itemId, action: p.action } }),
    'session.create': async (p) => call('session/create', { request: p }),
    'session.rename': async (p) => call('session/rename', { request: { sessionId: p.sessionId, title: p.title } }),
    'session.fork': async (p) => call('session/fork', { request: p }),
    'session.selectModel': async (p) => call('session/selectModel', { request: p }),
    'session.models': async (p) => {
      const [catalog, proj] = await Promise.all([call('session/modelCatalog', {}), call('session/projections', { request: { sessionId: p.sessionId } }).catch(() => null)]);
      const sel = obj(obj(obj(proj).values).modelSelection);
      return { ...catalog, current: sel.next || sel.lastUsed || catalog.default };
    },
    'subagent.list': async (p) => {
      const proj = await call('session/projections', { request: { sessionId: p.parentSessionId } });
      const catalog = obj(obj(proj).values).subagentCatalog;
      const entries = (Array.isArray(catalog) ? catalog : []).map((e) => ({ kind: 'child', id: e.id, mode: e.mode, label: e.label, activity: running.get(e.id) ? 'running' : 'inactive', hasChildren: false }));
      return { entries, parentAvailable: !!proj };
    },
    'workspace.list': async () => workspaceBaseline(),
    'workspace.archiveSession': async (p) => call('workspace/archiveSession', { request: { sessionId: p.sessionId } }),
    'host.listDirectory': async (p) => call('directoryPicker/list', { path: p.path }),
    'agentPreset.list': async () => call('agentPresets/list', {}),
  };

  /** 0.1's `remote(method, args)` calls were already namespaced; only a few arguments were renamed. */
  const remoteArgs = {
    'commands/execute': (a) => ({ agentId: a.agentId, line: a.line, submittedAttachments: (a.images || []).map((im) => ({ type: 'image', ...im })) }),
  };

  return {
    connect,
    close,
    isOpen: () => !!ws && ws.readyState === 1,
    clientId: () => clientId,
    /** A 0.1 method by name, or null when this adapter has no equivalent. */
    has: (method) => Object.hasOwn(methods, method),
    rpc: (method, payload, rpcId) => {
      const fn = methods[method];
      if (!fn) return Promise.reject(Object.assign(new Error(`${method} is not available on this dsh`), { code: 'unsupported' }));
      return fn(obj(payload), rpcId).catch((e) => { throw e && e.code ? Object.assign(e, { code: bareCode(e.code) }) : e; });
    },
    remote: (method, args) => call(method, (remoteArgs[method] || ((a) => a))(obj(args))),
    /** Answer a pending approval or question: the page's `respond(rpcId, result)`. */
    async respond(eventId, result) {
      if (!clientId) throw new Error('not connected to dsh');
      const r = obj(result);
      let outcome;
      if (r.ok) {
        const v = obj(r.value);
        outcome = { kind: 'result', value: v.outcome !== undefined ? v.outcome : v.answer };
      } else {
        const e = obj(r.error);
        outcome = { kind: 'rejected', error: { name: 'Error', message: str(e.message) || 'Skipped', code: str(e.code) } };
      }
      await call('$events/result', { clientId, eventId, outcome });
      // dsh does not echo a waterfall's cancel back to the client that answered it.
      const kind = pending.get(eventId);
      pending.delete(eventId);
      if (kind === 'approval') emit([{ kind: 'mux', payload: { type: 'approval/resolved', approvalId: eventId } }]);
      if (kind === 'question') emit([{ kind: 'mux', payload: { type: 'question/resolved', questionRpcId: eventId } }]);
      return {};
    },
    followSession,
  };
}

if (typeof window !== 'undefined') {
  window.dsh02 = { createClient, MUX_PATH, bareCode, fromPluginInventory, localizedText };
}
