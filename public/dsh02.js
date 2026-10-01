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
//   - `job/list` is one session's background-job roster (its own plus every unowned job),
//     replaced whole on each lifecycle change; `job/follow` one job's retained output and its
//     terminal status; `job/kill` stops a running job on a person's behalf. There is no
//     host-wide jobs feed, so the adapter opens one `job/list` stream per watched session.
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

/** Card id for a question read from the `userQuestions` projection rather than a live waterfall. */
export const questionKey = (sessionId, callId) => `question:${String(sessionId)}:${String(callId)}`;
const isQuestionKey = (id) => typeof id === 'string' && id.startsWith('question:');
const callKey = (sessionId, callId) => `${String(sessionId)}\u0000${String(callId)}`;

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
 * One `job/list` frame (`{type:'rows', jobs}`) as the `session/jobs` frame the page has
 * always read: the complete set for one session, so an empty set still reaches the page as
 * `[]` and can express "the last job just went away". The 0.2 `JobView` is a superset of
 * the 0.1 one, so only the fields the page uses are carried over (`output` stays just the
 * byte coordinates, not the retained bytes or spill paths).
 */
export function fromJobs(item, sessionId) {
  const v = obj(item);
  if (v.type !== 'rows') return [];
  const jobs = (Array.isArray(v.jobs) ? v.jobs : []).map((j) => {
    const s = obj(j);
    const out = { id: s.id, kind: s.kind, label: s.label, status: s.status, startedAt: s.startedAt };
    if (s.detail !== undefined) out.detail = s.detail;
    if (s.finishedAt !== undefined) out.finishedAt = s.finishedAt;
    const o = obj(s.output);
    if (typeof o.total === 'number') out.output = { total: o.total, earliest: typeof o.earliest === 'number' ? o.earliest : 0 };
    return out;
  });
  return [{ kind: 'mux', payload: { type: 'session/jobs', sessionId, jobs } }];
}

/**
 * One `job/follow` frame as a transient `job/output` frame for the page: `opened` anchors a
 * fresh read, `output` carries retained or live chunks, and the terminal `status` carries the
 * settled `JobView` (its `detail` is the exit status). `sessionId` is the job's owner, or
 * undefined for an unowned job, which is what `job/list` reported for it.
 */
export function fromJobFollow(item, sessionId, jobId) {
  const v = obj(item);
  const base = { type: 'job/output', sessionId, jobId };
  if (v.type === 'opened') return [{ kind: 'mux', payload: { ...base, kind: 'opened', job: v.job } }];
  if (v.type === 'output') return [{ kind: 'mux', payload: { ...base, kind: 'output', chunks: Array.isArray(v.chunks) ? v.chunks : [], lossy: v.lossy === true } }];
  if (v.type === 'status') return [{ kind: 'mux', payload: { ...base, kind: 'status', job: v.job } }];
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

/**
 * A session's goal as the page shows it, from the `goal` projection (`{goal, roundsStarted}`) or a
 * `goals/get` view (the same fields flat, plus `activation`). Null when there is no goal.
 */
export function goalOf(value) {
  const v = obj(value);
  const g = v.goal && typeof v.goal === 'object' ? v.goal : v;
  if (typeof g.objective !== 'string' || typeof g.id !== 'string' || typeof g.revision !== 'number') return null;
  const reason = obj(g.blockedReason);
  return {
    ref: { id: g.id, revision: g.revision },
    objective: g.objective,
    phase: str(g.phase) || 'active',
    blocked: str(reason.message),
    maxRounds: typeof g.maxGoalRounds === 'number' ? g.maxGoalRounds : null,
    rounds: typeof v.roundsStarted === 'number' ? v.roundsStarted : 0,
    activation: str(v.activation),
  };
}

const GOAL_GLYPH = { active: '●', paused: '⏸', blocked: '⚠', complete: '✓' };
/** The short status for a goal: glyph, phase and rounds against the cap. An active goal that will not continue on its own says so. */
export function goalStatus(g) {
  const idle = g.phase === 'active' && g.activation === 'disarmed';
  const phase = idle ? 'active, not continuing' : g.phase;
  const rounds = g.maxRounds ? `${g.rounds}/${g.maxRounds} rounds` : `${g.rounds} rounds`;
  return { glyph: GOAL_GLYPH[g.phase] || '●', level: g.phase === 'blocked' ? 'err' : (idle ? 'warn' : g.phase), text: `${phase} · ${rounds}` };
}

// ---------- Tool presentation ----------
//
// dsh 0.1 sent each tool event with the view its tool's `presentCall` / `presentResult` made
// (dsh-tools' presentation vocabulary: `card: 'diff' | 'terminal' | ...`). dsh 0.2 runs neither on
// the wire: `tool/call` carries the raw `arguments` string and `tool/result` the model-facing
// result plus the tool's private `meta` (dsh-session's event map). dsh's own web client
// (dsh-client-ui-tool's diff and terminal card models) rebuilds the cards from those, and so do
// these two functions, returning the 0.1 views the page and public/review.js already read.

const SHELLS = new Set(['bash', 'pwsh']);

function argsOf(raw) {
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { return null; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/** The one text block a first-party result renders from, or undefined for any other layout. */
function onlyText(content) {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const b = obj(content[0]);
  return b.type === 'text' && typeof b.text === 'string' ? b.text : undefined;
}

// A foreground shell call. A call without `description` is the persistent shell (dsh-tool-bash-persistent
// takes only `command`); a background one acknowledges a job rather than running to an exit.
function shellCall(name, a) {
  if (!SHELLS.has(name) || !a || typeof a.command !== 'string' || !a.command.trim()) return null;
  if (a.run_in_background === true) return null;
  return { command: a.command, description: str(a.description), workdir: str(a.workdir), persistent: a.description === undefined };
}

// The change a write, edit or str_replace_editor call means to make, from its arguments.
function intendedDiff(name, a) {
  if (!a) return null;
  if (name === 'str_replace_editor') {
    const path = a.path;
    if (typeof path !== 'string' || !path.trim()) return null;
    if (a.command === 'create' && (a.file_text === undefined || typeof a.file_text === 'string')) return { path, oldText: null, newText: a.file_text ?? '' };
    if (a.command === 'str_replace' && (a.old_str === undefined || typeof a.old_str === 'string') && (a.new_str === undefined || typeof a.new_str === 'string')) return { path, oldText: a.old_str || null, newText: a.new_str ?? '' };
    return null;
  }
  const path = a.file_path;
  if (typeof path !== 'string' || !path.trim()) return null;
  if (name === 'write') return typeof a.content === 'string' ? { path, oldText: null, newText: a.content } : null;
  if (name === 'edit' && typeof a.old_string === 'string' && typeof a.new_string === 'string') return { path, oldText: a.old_string || null, newText: a.new_string };
  return null;
}

// dsh-tool-fs's result meta, `{diffs: FileDiff[], operation?}`: the applied hunks. 'empty' is a
// valid meta with no hunks (an unchanged overwrite); null is absent or malformed.
function appliedDiffs(meta) {
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  if (!m || !Array.isArray(m.diffs)) return null;
  if (!m.diffs.length) return 'empty';
  const out = [];
  for (const d of m.diffs) {
    const x = obj(d);
    if (typeof x.path !== 'string' || typeof x.newText !== 'string' || (x.oldText !== null && typeof x.oldText !== 'string')) return null;
    out.push({ path: x.path, oldText: x.oldText, newText: x.newText });
  }
  return out;
}

// The exit markers dsh-shell's renderer appends (`parseExitStatus` in dsh-shell/render): a signal,
// a non-zero code, or neither for a clean exit.
function exitStatus(text) {
  const sig = /(?:^|\n)\[killed by signal: ([^\]\n]+)\]$/.exec(text); // a silent command's result is the marker alone
  if (sig) return { output: text.slice(0, sig.index), signal: sig[1] };
  const code = /(?:^|\n)\[exit code: (\d+)\]$/.exec(text);
  if (code) return { output: text.slice(0, code.index), exitCode: Number(code[1]) };
  return { output: text, exitCode: 0 };
}

// A result dsh-spill-policy cut short ends in its notice, which can hide the exit marker.
const spilled = (text) => text.endsWith(')') && text.includes(' Full formatted result stored at: ');

/** The 0.1 call view for a 0.2 `tool/call`, or null for the generic row. */
export function toolCallView(name, argsRaw) {
  const a = argsOf(argsRaw);
  const sh = shellCall(name, a);
  if (sh) {
    const v = { card: 'terminal', title: sh.command };
    if (sh.description) v.description = sh.description;
    if (sh.workdir) v.cwd = sh.workdir;
    return v;
  }
  const d = intendedDiff(name, a);
  if (!d) return null;
  const verb = name === 'write' || (name === 'str_replace_editor' && a.command === 'create') ? 'Write' : 'Edit';
  return { card: 'diff', title: `${verb} ${d.path}`, diffs: [d] };
}

/**
 * The 0.1 result view for a 0.2 `tool/result` of the call `name(argsRaw)`, or null when there is
 * nothing to add to the raw result. `result` is `{content, isError, meta}`: the tool-result block's
 * content and error flag, and the event's `meta`.
 */
export function toolResultView(name, argsRaw, result) {
  const r = obj(result);
  const a = argsOf(argsRaw);
  const sh = shellCall(name, a);
  // A failed write changed nothing; a failed command still has output (and maybe an exit marker) worth showing.
  if (r.isError && !sh) return null;
  if (sh) {
    const text = onlyText(r.content);
    if (text === undefined) return null;
    if (sh.persistent) {
      // The persistent shell reports its own marker when the command finished.
      const m = /\n?\[Command finished with exit code (\d+)\]$/.exec(text);
      return m ? { card: 'terminal', output: text.slice(0, m.index), exitCode: Number(m[1]) } : { card: 'terminal', output: text };
    }
    if (spilled(text)) return { card: 'terminal', output: text };
    const st = exitStatus(text);
    // An errored call with no marker did not exit cleanly: keep its output, claim no exit code.
    if (r.isError && st.exitCode === 0 && !st.signal) return { card: 'terminal', output: st.output };
    return { card: 'terminal', ...st };
  }
  const d = intendedDiff(name, a);
  if (!d) return null;
  // str_replace_editor has no result view on dsh 0.2, and an edit is only drawn from its applied hunks.
  if (name === 'str_replace_editor') return { card: 'generic' };
  const applied = appliedDiffs(r.meta);
  // 'empty' (diffs: []) is how dsh-tool-fs marks a write that created the file (before === null); its
  // own presentResult then draws the whole new file, so a write falls through to the intended diff.
  if (Array.isArray(applied)) return { card: 'diff', diffs: applied };
  return name === 'write' ? { card: 'diff', diffs: [d] } : { card: 'generic' };
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
  const wanted = new Set(); // sessions whose job/list roster the page wants watched
  const jobWatch = new Map(); // sessionId -> the open job/list streamId
  const jobStream = new Map(); // job/list streamId -> sessionId
  const obsWanted = new Map(); // jobId -> owning sessionId, for open job/follow streams
  const obs = new Map(); // jobId -> {sessionId, streamId}
  const obsStream = new Map(); // job/follow streamId -> jobId
  // The `subagentCatalog` projection only lists a session's direct children, and the
  // control feed may omit a child session's own catalog. Cache every catalog this
  // client has seen (control push, snapshot, or a read) and probe only what is
  // missing, so `subagent.list` can answer `hasChildren` and the page can recurse.
  const catalogs = new Map(); // sessionId -> direct-child catalog entries
  const catalogReads = new Map(); // sessionId -> in-flight projections read
  const timings = new Map(); // sessionId -> the subagentTiming projection
  // Questions the projection reports as `continued`: their timed wait ran out and the
  // agent moved on, but they are still answerable through `userQuestions/answer`.
  const projected = new Map(); // rpcId -> {sessionId, callId, sig}
  const liveQuestionCall = new Map(); // sessionId\0callId -> waterfall eventId
  const liveQuestionEvent = new Map(); // waterfall eventId -> {sessionId, callId}
  const questionViews = new Map(); // sessionId -> the last userQuestions projection view
  const inboxes = new Map(); // sessionId -> the inbox projection value

  const call = (endpoint, args, rpcId) => transport(endpoint, { args }, rpcId);
  const emit = (frames) => {
    for (const f of frames) {
      const p = f.payload;
      if (f.kind === 'host' && p.type === 'host/session-status') running.set(p.sessionId, p.running);
      const env = f.env || {};
      if (p.type === 'question/requested' && p.callId && env.rpcId && !isQuestionKey(env.rpcId)) {
        liveQuestionCall.set(callKey(p.sessionId, p.callId), env.rpcId);
        liveQuestionEvent.set(env.rpcId, { sessionId: p.sessionId, callId: p.callId });
      } else if (p.type === 'question/resolved' && p.questionRpcId && !isQuestionKey(p.questionRpcId)) {
        const was = liveQuestionEvent.get(p.questionRpcId);
        if (was) liveQuestionCall.delete(callKey(was.sessionId, was.callId));
        liveQuestionEvent.delete(p.questionRpcId);
      }
      onFrame(f.kind, p, env);
    }
  };
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const open = (streamId, endpoint, args) => send({ type: 'open', streamId, endpoint, payload: { args } });
  const connected = () => !!ws && ws.readyState === 1;

  // One job/list stream per watched session. The roster is the only 0.2 surface that says
  // which jobs a session has, and it replaces the whole set on every lifecycle change.
  function openJobList(sessionId) {
    const streamId = `j${++seqNo}`;
    jobWatch.set(sessionId, streamId);
    jobStream.set(streamId, sessionId);
    open(streamId, 'job/list', { request: { sessionId } });
  }
  function closeJobList(sessionId) {
    const streamId = jobWatch.get(sessionId);
    if (streamId === undefined) return;
    send({ type: 'cancel', streamId });
    jobWatch.delete(sessionId);
    jobStream.delete(streamId);
  }
  // One job/follow stream per job the page is looking at. `from` is omitted, so the host
  // starts at the oldest retained byte; the stream ends by itself after the terminal status.
  function openObs(jobId, sessionId) {
    const streamId = `o${++seqNo}`;
    obs.set(jobId, { sessionId, streamId });
    obsStream.set(streamId, jobId);
    open(streamId, 'job/follow', { request: { sessionId, jobId } });
  }
  function dropObs(jobId) {
    const e = obs.get(jobId);
    if (!e) return;
    obs.delete(jobId);
    obsStream.delete(e.streamId);
  }
  function failJobList(streamId) {
    const sessionId = jobStream.get(streamId);
    if (sessionId === undefined) return;
    jobStream.delete(streamId);
    if (jobWatch.get(sessionId) === streamId) jobWatch.delete(sessionId);
    // Drop the session's roster rather than keep a stale one; a later watchJobs retries.
    emit([{ kind: 'mux', payload: { type: 'session/jobs', sessionId, jobs: [] } }]);
  }
  function failObs(streamId, error) {
    const jobId = obsStream.get(streamId);
    if (jobId === undefined) return;
    const sessionId = (obs.get(jobId) || {}).sessionId;
    dropObs(jobId);
    emit([{ kind: 'mux', payload: { type: 'job/output', sessionId, jobId, kind: 'error', error: { message: (error && error.message) || 'job output failed' } } }]);
  }
  function endObs(streamId) {
    const jobId = obsStream.get(streamId);
    if (jobId === undefined) return;
    const sessionId = (obs.get(jobId) || {}).sessionId;
    dropObs(jobId);
    emit([{ kind: 'mux', payload: { type: 'job/output', sessionId, jobId, kind: 'end' } }]);
  }

  // Keep the projection caches in step with the control feed, and turn a
  // `userQuestions` view into expired-question cards for the page.
  function cacheProjection(p) {
    if (!p || p.type !== 'session/projection') return;
    if (p.key === 'subagentCatalog') catalogs.set(p.sessionId, Array.isArray(p.value) ? p.value : []);
    else if (p.key === 'subagentTiming') timings.set(p.sessionId, p.value);
    else if (p.key === 'userQuestions') { questionViews.set(p.sessionId, p.value); syncQuestions(p.sessionId, p.value); }
    // Before this session's userQuestions view has arrived (a reconnect baseline can send inbox
    // first), there is nothing to sync against: resolving now would drop every remembered question.
    else if (p.key === 'inbox') { inboxes.set(p.sessionId, p.value); if (questionViews.has(p.sessionId)) syncQuestions(p.sessionId, questionViews.get(p.sessionId)); }
  }

  /** Call ids whose late answer a client already steered into this session's inbox. */
  function queuedReplies(sessionId) {
    const out = new Set();
    const b = obj(inboxes.get(sessionId));
    for (const list of ['next-turn', 'next-step']) {
      for (const m of Array.isArray(b[list]) ? b[list] : []) {
        const source = obj(obj(m).source);
        if (source.kind === 'user-question-reply' && typeof source.callId === 'string') out.add(source.callId);
      }
    }
    return out;
  }

  /**
   * Mirror the `userQuestions` projection's `continued` rows as expired question cards.
   * A row is `continued` once the timed wait ran out and the agent carried on; it is
   * still answerable, so it stays until the projection drops it. A live waterfall for
   * the same call is retired first, so one call never shows two cards, and a call whose
   * reply already sits in the inbox stays hidden, as dsh's own client hides it.
   */
  function syncQuestions(sessionId, view) {
    const active = Array.isArray(obj(view).active) ? obj(view).active : [];
    const continued = new Map(); // callId -> questions
    for (const row of active) {
      const r = obj(row);
      if (r.state === 'continued' && typeof r.callId === 'string') continued.set(r.callId, r.questions);
    }
    const queued = queuedReplies(sessionId);
    const live = new Set([...continued.keys()].filter((callId) => !queued.has(callId)));
    for (const [rpcId, info] of [...projected]) {
      if (info.sessionId !== sessionId || live.has(info.callId)) continue;
      projected.delete(rpcId);
      emit([{ kind: 'mux', payload: { type: 'question/resolved', questionRpcId: rpcId } }]);
    }
    for (const callId of live) {
      const waterfall = liveQuestionCall.get(callKey(sessionId, callId));
      if (waterfall) {
        const was = liveQuestionEvent.get(waterfall);
        if (was) liveQuestionCall.delete(callKey(was.sessionId, was.callId));
        liveQuestionEvent.delete(waterfall);
        pending.delete(waterfall);
        emit([{ kind: 'mux', payload: { type: 'question/resolved', questionRpcId: waterfall } }]);
      }
      const rpcId = questionKey(sessionId, callId);
      const sig = JSON.stringify(continued.get(callId));
      const prev = projected.get(rpcId);
      if (prev && prev.sig === sig) continue;
      projected.set(rpcId, { sessionId, callId, sig });
      emit([{ kind: 'mux', env: { rpcId }, payload: { type: 'question/requested', sessionId, callId, questions: continued.get(callId), expired: true } }]);
    }
  }

  // Read one session's direct-child catalog, deduping concurrent reads. A session
  // the control feed already described never reaches the network.
  function catalogOf(sessionId) {
    if (catalogs.has(sessionId)) return Promise.resolve(catalogs.get(sessionId));
    const inflight = catalogReads.get(sessionId);
    if (inflight) return inflight;
    const read = call('session/projections', { request: { sessionId } })
      .then((proj) => {
        const values = obj(obj(proj).values);
        const entries = Array.isArray(values.subagentCatalog) ? values.subagentCatalog : [];
        catalogs.set(sessionId, entries);
        if (values.subagentTiming !== undefined) timings.set(sessionId, values.subagentTiming);
        return entries;
      })
      .catch(() => []);
    const tracked = read.finally(() => catalogReads.delete(sessionId));
    catalogReads.set(sessionId, tracked);
    return tracked;
  }

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
      const frames = fromControl(value);
      emit(frames);
      for (const f of frames) cacheProjection(f.payload);
    } else if (streamId === 'ws') {
      if (value && value.type === 'baseline') {
        workspace = obj(value.value);
        const waiters = workspaceWaiters; workspaceWaiters = [];
        for (const w of waiters) w(workspace);
      } else if (workspace && value && value.type === 'archived') workspace = { ...workspace, archivedSessionIds: value.archivedSessionIds };
      emit(fromWorkspace(value));
    } else if (jobStream.has(streamId)) {
      emit(fromJobs(value, jobStream.get(streamId)));
    } else if (obsStream.has(streamId)) {
      const jobId = obsStream.get(streamId);
      emit(fromJobFollow(value, (obs.get(jobId) || {}).sessionId, jobId));
    } else if (follow && streamId === follow.streamId) {
      if (value && value.type === 'snapshot') {
        cursors.set(follow.sessionId, value.cursor);
        for (const [key, val] of Object.entries(obj(obj(value.projections).values))) {
          cacheProjection({ type: 'session/projection', sessionId: follow.sessionId, key, value: val });
        }
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
    // A job stream failing is local to that session (or that job); it must not take the
    // whole feed down the way a failed $events/session/control/workspace stream does.
    if (obsStream.has(streamId)) { failObs(streamId, error); return; }
    if (jobStream.has(streamId)) { failJobList(streamId); return; }
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
      // The streams below belong to the socket that closed; their wanted sets survive, so
      // every reconnect restores the rosters and the open output reads on the new socket.
      jobWatch.clear(); jobStream.clear();
      obs.clear(); obsStream.clear();
      for (const sessionId of wanted) openJobList(sessionId);
      for (const [jobId, sessionId] of obsWanted) openObs(jobId, sessionId);
    };
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'item') onItem(m.streamId, m.value);
      else if (m.type === 'error') fail(m.streamId, m.error);
      else if (m.type === 'end') endObs(m.streamId);
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null; clientId = null;
      // A reconnect re-reads the control baseline and re-probes catalogs; a pending
      // waterfall is replayed, so its live mapping is rebuilt then.
      pending.clear(); liveQuestionCall.clear(); liveQuestionEvent.clear();
      jobWatch.clear(); jobStream.clear();
      obs.clear(); obsStream.clear();
      catalogs.clear(); catalogReads.clear(); timings.clear(); questionViews.clear(); inboxes.clear();
      onDown();
    };
  }

  function close() {
    if (!ws) return;
    const sock = ws; ws = null; clientId = null;
    pending.clear(); liveQuestionCall.clear(); liveQuestionEvent.clear();
    jobWatch.clear(); jobStream.clear();
    obs.clear(); obsStream.clear();
    catalogs.clear(); catalogReads.clear(); timings.clear(); questionViews.clear(); inboxes.clear();
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
    // The 0.1 contract answers one parent's direct children with `hasChildren` and
    // `activity`. The 0.2 `subagentCatalog` projection is only that parent's direct
    // children, so follow it down: probe a child's own catalog when the control feed
    // has not described it, and the page's recursion reaches every generation.
    'subagent.list': async (p) => {
      const parentId = p.parentSessionId;
      let parentAvailable = true;
      if (!catalogs.has(parentId)) {
        const proj = await call('session/projections', { request: { sessionId: parentId } }).catch(() => null);
        parentAvailable = !!proj;
        const values = obj(obj(proj).values);
        // Cache only an answer: a failed read must not stick as "no children".
        if (proj) catalogs.set(parentId, Array.isArray(values.subagentCatalog) ? values.subagentCatalog : []);
        if (values.subagentTiming !== undefined) timings.set(parentId, values.subagentTiming);
      }
      const rows = catalogs.get(parentId) || [];
      const entries = await Promise.all(rows.map(async (e) => {
        const id = e.id;
        if (!catalogs.has(id)) await catalogOf(id);
        const hasChildren = (catalogs.get(id) || []).length > 0;
        const active = running.get(id) === true || !!obj(timings.get(id)).active;
        return { kind: 'child', id, mode: e.mode, label: e.label, activity: active ? 'running' : 'inactive', hasChildren };
      }));
      return { entries, parentAvailable };
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
    /**
     * Reconcile the `job/list` rosters the page wants watched: open one for each new
     * session, cancel the ones that left the list. The wanted set survives a dropped
     * socket, so a reconnect restores every roster without the page asking again.
     */
    watchJobs(ids) {
      const want = new Set((Array.isArray(ids) ? ids : []).map(String));
      for (const sessionId of [...wanted]) if (!want.has(sessionId)) { closeJobList(sessionId); wanted.delete(sessionId); }
      for (const sessionId of want) {
        wanted.add(sessionId);
        if (!jobWatch.has(sessionId) && connected()) openJobList(sessionId);
      }
    },
    /** Follow one job's retained output and terminal status, once per job id. */
    observeJob(sessionId, jobId) {
      const id = String(jobId);
      if (obsWanted.has(id)) return;
      obsWanted.set(id, sessionId);
      if (connected()) openObs(id, sessionId);
    },
    /** Stop following a job's output; the page calls this when it collapses the row. */
    stopObserve(jobId) {
      const id = String(jobId);
      obsWanted.delete(id);
      const e = obs.get(id);
      if (e) { send({ type: 'cancel', streamId: e.streamId }); dropObs(id); }
    },
    /** Kill one running job on the user's behalf; resolves with `{outcome}`. 0.2 only. */
    killJob: (sessionId, jobId) => call('job/kill', { request: { sessionId, jobId } }),
    /** A 0.1 method by name, or null when this adapter has no equivalent. */
    has: (method) => Object.hasOwn(methods, method),
    rpc: (method, payload, rpcId) => {
      const fn = methods[method];
      if (!fn) return Promise.reject(Object.assign(new Error(`${method} is not available on this dsh`), { code: 'unsupported' }));
      return fn(obj(payload), rpcId).catch((e) => { throw e && e.code ? Object.assign(e, { code: bareCode(e.code) }) : e; });
    },
    remote: (method, args) => call(method, (remoteArgs[method] || ((a) => a))(obj(args))),
    /**
     * Answer a pending approval or question: the page's `respond(rpcId, result)`.
     * A question read from the `userQuestions` projection is no longer a waterfall,
     * so it goes through dsh 0.2's `userQuestions/answer` late-answer path instead.
     */
    async respond(rpcId, result) {
      const r = obj(result);
      const expired = projected.get(rpcId);
      if (expired) {
        if (!r.ok) {
          projected.delete(rpcId);
          emit([{ kind: 'mux', payload: { type: 'question/resolved', questionRpcId: rpcId } }]);
          return {};
        }
        const answer = obj(obj(r.value).answer);
        const accepted = await call('userQuestions/answer', { agentId: expired.sessionId, callId: expired.callId, answer });
        if (accepted === false) throw Object.assign(new Error('this question is no longer answerable'), { code: 'question-closed' });
        projected.delete(rpcId);
        emit([{ kind: 'mux', payload: { type: 'question/resolved', questionRpcId: rpcId } }]);
        return {};
      }
      if (!clientId) throw new Error('not connected to dsh');
      let outcome;
      if (r.ok) {
        const v = obj(r.value);
        outcome = { kind: 'result', value: v.outcome !== undefined ? v.outcome : v.answer };
      } else {
        const e = obj(r.error);
        outcome = { kind: 'rejected', error: { name: 'Error', message: str(e.message) || 'Skipped', code: str(e.code) } };
      }
      await call('$events/result', { clientId, eventId: rpcId, outcome });
      // dsh does not echo a waterfall's cancel back to the client that answered it.
      const kind = pending.get(rpcId);
      pending.delete(rpcId);
      if (kind === 'approval') emit([{ kind: 'mux', payload: { type: 'approval/resolved', approvalId: rpcId } }]);
      if (kind === 'question') emit([{ kind: 'mux', payload: { type: 'question/resolved', questionRpcId: rpcId } }]);
      return {};
    },
    followSession,
  };
}

if (typeof window !== 'undefined') {
  window.dsh02 = { createClient, MUX_PATH, bareCode, fromPluginInventory, localizedText, goalOf, goalStatus, toolCallView, toolResultView };
}
