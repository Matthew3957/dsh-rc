// Hand-written demo sessions for scripts/demo-dsh.mjs, the mock of the dsh API.
//
// Everything here is invented: the projects live under /work/demo, the people and
// hosts do not exist, and the ids are plain words. Shapes follow the zod schemas in
// @deepseek-ai/dsh-host-apiproxy/lib/types/api (sessions, events, jobs, subagents,
// workspace, host) and the event map in @deepseek-ai/dsh-session; see the comments
// beside each builder.
//
// buildDemo(now) returns the whole world relative to one instant, so the same
// fixtures read the same at any `now` (the screenshot script pins it).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const PROVIDER = 'deepseek-v41';
export const MODEL = 'deepseek-flash';

export const ID = Object.freeze({
  pagination: 'demo-pagination', // running, waiting on an approval
  toml: 'demo-toml',             // running, context nearly full
  offByOne: 'demo-off-by-one',   // finished, the diff and summary session
  router: 'demo-router',         // plan mode, waiting on a plan review
  lint: 'demo-lint',
  backoff: 'demo-backoff',
  helpers: 'demo-helpers',
  notes: 'demo-notes',
  subTests: 'demo-sub-tests',
  subSurvey: 'demo-sub-survey',
});

export const APPROVAL_RPC = 'demo-approval-rpc';
export const PLAN_RPC = 'demo-plan-rpc';

// ---------- event builders ----------
// A SessionEvent is { seq, time, type, data } (events.d.ts, sessions.schema). The data
// of each type follows SessionEventMap in dsh-session: user/message is a UserMessage,
// assistant/message carries { turn, step, message, usage }, tool/call carries the raw
// JSON `arguments` string, tool/result a ToolResultMessage, turn/* a turn number.

function createLog(startAt) {
  const events = [];
  let t = startAt;
  let n = 0;
  const push = (type, data, view, gap = 4000) => {
    t += gap;
    const entry = { event: { seq: events.length, time: t, type, data } };
    if (view) entry.view = view;
    events.push(entry);
    return entry;
  };
  const id = (p) => `${p}-${++n}`;
  return {
    events,
    get time() { return t; },
    tick(ms) { t += ms; },
    turnStart: (turn) => push('turn/start', { turn }, null, 1500),
    turnEnd: (turn, kind = 'completed') => push('turn/end', { turn, reason: { kind } }, null, 1500),
    user(text) {
      return push('user/message', { id: id('msg'), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, null, 2000);
    },
    // One model step: optional text, optional tool calls, and its token usage.
    assistant(turn, step, { text, calls = [], usage }) {
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const c of calls) content.push({ type: 'tool-call', id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
      const data = { turn, step, message: { id: id('msg'), role: 'assistant', content, source: { kind: 'model', provider: PROVIDER, model: MODEL } } };
      if (usage) data.usage = usage;
      return push('assistant/message', data, null, 5000);
    },
    call(turn, step, c, view) {
      return push('tool/call', { turn, step, callId: c.id, name: c.name, arguments: JSON.stringify(c.args) }, { for: 'call', view }, 300);
    },
    result(turn, step, c, text, view, isError = false) {
      const block = { type: 'tool-result', toolCallId: c.id, content: [{ type: 'text', text }] };
      if (isError) block.isError = true;
      const message = { id: id('msg'), role: 'user', content: [block], source: { kind: 'tool', callId: c.id } };
      return push('tool/result', { turn, step, message }, { for: 'result', view }, 1800);
    },
  };
}

// dsh-tools presentation vocabulary (presentation.d.ts): generic, terminal and diff cards.
const genericView = (title) => ({ card: 'generic', title });
const terminalCall = (command) => ({ card: 'terminal', title: command });
const terminalResult = (output, exitCode) => ({ card: 'terminal', output, exitCode });
const diffView = (title, path, oldText, newText) => ({ card: 'diff', title, diffs: [{ path, oldText, newText }] });

const lines = (...l) => l.join('\n') + '\n';

// ---------- the diff session ----------

const NOTES = '/work/demo/notes-api';

const PAGINATION_OLD = lines(
  "// Page helpers for the notes API.",
  "const DEFAULT_LIMIT = 20;",
  "",
  "export function paginate(items, page = 1, limit = DEFAULT_LIMIT) {",
  "  const start = (page - 1) * limit;",
  "  const end = start + limit + 1;",
  "  const slice = items.slice(start, end);",
  "  return {",
  "    items: slice,",
  "    page,",
  "    limit,",
  "    total: items.length,",
  "    hasMore: end < items.length,",
  "  };",
  "}",
);
const PAGINATION_NEW = lines(
  "// Page helpers for the notes API.",
  "const DEFAULT_LIMIT = 20;",
  "",
  "export function paginate(items, page = 1, limit = DEFAULT_LIMIT) {",
  "  const start = (page - 1) * limit;",
  "  const end = start + limit;",
  "  const slice = items.slice(start, end);",
  "  return {",
  "    items: slice,",
  "    page,",
  "    limit,",
  "    total: items.length,",
  "    hasMore: end < items.length,",
  "  };",
  "}",
);
const PAGINATION_TEST = lines(
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { paginate } from '../src/pagination.js';",
  "",
  "const notes = Array.from({ length: 45 }, (_, i) => ({ id: i + 1 }));",
  "",
  "test('the last page holds only what is left', () => {",
  "  const r = paginate(notes, 3, 20);",
  "  assert.equal(r.items.length, 5);",
  "  assert.equal(r.hasMore, false);",
  "});",
  "",
  "test('a full page never carries an extra note', () => {",
  "  assert.equal(paginate(notes, 1, 20).items.length, 20);",
  "});",
);

const GREP_OUT = lines(
  'src/pagination.js:4:export function paginate(items, page = 1, limit = DEFAULT_LIMIT) {',
  'src/routes/notes.js:12:  const result = paginate(all, Number(page), Number(limit));',
  'test/notes.test.js:31:  // paginate() is covered through the route tests',
);
const FAIL_OUT = lines(
  '> notes-api@1.4.0 test',
  '> node --test',
  '',
  '✖ the last page holds only what is left (1.2ms)',
  '  AssertionError: 6 !== 5',
  '✔ a full page never carries an extra note (0.4ms)',
  '',
  'ℹ tests 2',
  'ℹ pass 1',
  'ℹ fail 1',
);
const PASS_OUT = lines(
  '> notes-api@1.4.0 test',
  '> node --test',
  '',
  '✔ the last page holds only what is left (0.9ms)',
  '✔ a full page never carries an extra note (0.3ms)',
  '✔ GET /notes answers with the first page (4.1ms)',
  '',
  'ℹ tests 3',
  'ℹ pass 3',
  'ℹ fail 0',
);

function offByOneLog(now) {
  const log = createLog(now - 26 * MIN);
  const read = { id: 'call-read', name: 'read', args: { file_path: `${NOTES}/src/pagination.js` } };
  const grep = { id: 'call-grep', name: 'grep', args: { pattern: 'paginate', path: `${NOTES}/src` } };
  const writeTest = { id: 'call-test', name: 'write', args: { file_path: `${NOTES}/test/pagination.test.js` } };
  const fail = { id: 'call-fail', name: 'bash', args: { command: 'npm test' } };
  const edit = { id: 'call-edit', name: 'edit', args: { file_path: `${NOTES}/src/pagination.js` } };
  const pass = { id: 'call-pass', name: 'bash', args: { command: 'npm test' } };

  log.turnStart(1);
  log.user('GET /notes returns 21 notes on a full page when the limit is 20. Can you find out why and fix it?');
  log.assistant(1, 1, {
    text: 'I will start by finding where pages are cut.',
    calls: [grep],
    usage: { inputTokens: 1850, outputTokens: 96, cacheReadTokens: 0, cacheWriteTokens: 6200 },
  });
  log.call(1, 1, grep, genericView('grep paginate in src'));
  log.result(1, 1, grep, GREP_OUT, { card: 'generic' });
  log.assistant(1, 2, {
    text: 'The helper lives in `src/pagination.js`. Reading it.',
    calls: [read],
    usage: { inputTokens: 240, outputTokens: 58, cacheReadTokens: 6200, cacheWriteTokens: 410 },
  });
  log.call(1, 2, read, genericView('read src/pagination.js'));
  log.result(1, 2, read, PAGINATION_OLD, { card: 'generic' });
  log.assistant(1, 3, {
    text: 'Found it: `end` is computed as `start + limit + 1`, so `slice` always takes one note more than the limit. '
      + 'I will pin it down with a test first.',
    calls: [writeTest],
    usage: { inputTokens: 310, outputTokens: 430, cacheReadTokens: 6610, cacheWriteTokens: 820 },
  });
  log.call(1, 3, writeTest, diffView('write test/pagination.test.js', `${NOTES}/test/pagination.test.js`, null, PAGINATION_TEST));
  log.result(1, 3, writeTest, 'Wrote test/pagination.test.js', { card: 'diff', diffs: [{ path: `${NOTES}/test/pagination.test.js`, oldText: null, newText: PAGINATION_TEST }] });
  log.assistant(1, 4, {
    calls: [fail],
    usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 7430, cacheWriteTokens: 560 },
  });
  log.call(1, 4, fail, terminalCall('npm test'));
  // A non-zero exit is not an error result (dsh-tool-bash: only spawn errors and aborts are);
  // the exit code on the terminal view is what marks it failed.
  log.result(1, 4, fail, FAIL_OUT, terminalResult(FAIL_OUT, 1));
  log.assistant(1, 5, {
    text: 'The new test fails the way the route does (6 notes on a page that should hold 5). Fixing the bound.',
    calls: [edit],
    usage: { inputTokens: 180, outputTokens: 120, cacheReadTokens: 7990, cacheWriteTokens: 300 },
  });
  log.call(1, 5, edit, diffView('edit src/pagination.js', `${NOTES}/src/pagination.js`, PAGINATION_OLD, PAGINATION_NEW));
  log.result(1, 5, edit, 'Edited src/pagination.js', { card: 'diff', diffs: [{ path: `${NOTES}/src/pagination.js`, oldText: PAGINATION_OLD, newText: PAGINATION_NEW }] });
  log.assistant(1, 6, {
    calls: [pass],
    usage: { inputTokens: 90, outputTokens: 40, cacheReadTokens: 8290, cacheWriteTokens: 220 },
  });
  log.call(1, 6, pass, terminalCall('npm test'));
  log.result(1, 6, pass, PASS_OUT, terminalResult(PASS_OUT, 0));
  log.assistant(1, 7, {
    text: 'Fixed. `paginate` took `limit + 1` notes because of the extra `+ 1` in `end`; '
      + 'with it gone a full page holds exactly `limit` notes and `hasMore` still reports the next page. '
      + 'I added `test/pagination.test.js` so the last page and a full page stay covered, and all 3 tests pass.',
    usage: { inputTokens: 140, outputTokens: 210, cacheReadTokens: 8510, cacheWriteTokens: 0 },
  });
  log.turnEnd(1);

  log.tick(3 * MIN);
  log.turnStart(2);
  log.user('Why did the route tests not catch that?');
  log.assistant(2, 1, {
    text: 'They only checked the **first** page of a short list: fewer than `limit` notes, so the extra slot was '
      + 'never filled. The bug needs a list longer than one page to show up.\n\n'
      + 'The new tests use 45 notes, which covers a full page and a partial last page.',
    usage: { inputTokens: 210, outputTokens: 150, cacheReadTokens: 8650, cacheWriteTokens: 0 },
  });
  log.turnEnd(2);
  return log.events;
}

// ---------- the running sessions ----------

function paginationLog(now, turnStartAt) {
  const log = createLog(turnStartAt - 1500);
  const read = { id: 'call-read-routes', name: 'read', args: { file_path: `${NOTES}/src/routes/notes.js` } };
  const routeOld = lines(
    "import { paginate } from '../pagination.js';",
    "",
    "export function listNotes(req, res) {",
    "  const { page = 1, limit = 20 } = req.query;",
    "  const result = paginate(all(), Number(page), Number(limit));",
    "  res.json(result);",
    "}",
  );
  const routeNew = lines(
    "import { paginate, afterCursor } from '../pagination.js';",
    "",
    "export function listNotes(req, res) {",
    "  const { page = 1, limit = 20, cursor } = req.query;",
    "  if (cursor) return res.json(afterCursor(all(), cursor, Number(limit)));",
    "  const result = paginate(all(), Number(page), Number(limit));",
    "  res.json(result);",
    "}",
  );
  const edit = { id: 'call-edit-routes', name: 'edit', args: { file_path: `${NOTES}/src/routes/notes.js` } };
  const build = { id: 'call-build', name: 'bash', args: { command: 'npm run build && npm test' } };

  log.turnStart(1);
  log.user('Add cursor pagination to GET /notes. Keep page and limit working for existing clients.');
  log.assistant(1, 1, {
    text: 'Reading the route handler first.',
    calls: [read],
    usage: { inputTokens: 1600, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 5200 },
  });
  log.call(1, 1, read, genericView('read src/routes/notes.js'));
  log.result(1, 1, read, routeOld, { card: 'generic' });
  log.assistant(1, 2, {
    text: 'A `cursor` query parameter goes next to `page` and `limit`. When it is present the handler answers '
      + 'from `afterCursor`; otherwise nothing changes for existing clients.',
    calls: [edit],
    usage: { inputTokens: 260, outputTokens: 310, cacheReadTokens: 5200, cacheWriteTokens: 600 },
  });
  log.call(1, 2, edit, diffView('edit src/routes/notes.js', `${NOTES}/src/routes/notes.js`, routeOld, routeNew));
  log.result(1, 2, edit, 'Edited src/routes/notes.js', { card: 'diff', diffs: [{ path: `${NOTES}/src/routes/notes.js`, oldText: routeOld, newText: routeNew }] });
  log.assistant(1, 3, {
    text: 'Now a build and the test suite to check the new branch compiles.',
    calls: [build],
    usage: { inputTokens: 150, outputTokens: 80, cacheReadTokens: 5800, cacheWriteTokens: 400 },
  });
  log.call(1, 3, build, terminalCall('npm run build && npm test'));
  // No tool/result yet: the call is waiting on the approval the mux replays.
  return { events: log.events, build };
}

function tomlLog(turnStartAt) {
  const log = createLog(turnStartAt - 2000);
  const read = { id: 'call-read-config', name: 'read', args: { file_path: '/work/demo/config-lib/src/load.js' } };
  log.turnStart(1);
  log.user('Move the config loader from JSON to TOML. Keep the old file format working with a deprecation warning.');
  log.assistant(1, 1, {
    text: 'Looking at how the loader picks its parser.',
    calls: [read],
    usage: { inputTokens: 2100, outputTokens: 70, cacheReadTokens: 0, cacheWriteTokens: 7800 },
  });
  log.call(1, 1, read, genericView('read src/load.js'));
  return log.events;
}

// ---------- the plan-review session ----------

const PLAN_MD = [
  '**Goal:** split `src/router.js` into one module per resource.',
  '',
  '1. Create `src/routes/notes.js`, `tags.js` and `users.js`.',
  '2. Move each handler and its validators over, unchanged.',
  '3. Keep `src/router.js` as a short file that mounts them.',
  '4. Run the route tests after each move.',
  '',
  '**Not changing:** URL paths or response shapes.',
].join('\n');

function routerLog(now) {
  const log = createLog(now - 75 * MIN);
  const read = { id: 'call-read-router', name: 'read', args: { file_path: '/work/demo/notes-api/src/router.js' } };
  log.turnStart(1);
  log.user('Plan how to split src/router.js into one module per resource. Do not change anything yet.');
  log.assistant(1, 1, {
    text: 'Reading the router before proposing a split.',
    calls: [read],
    usage: { inputTokens: 1400, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 4300 },
  });
  log.call(1, 1, read, genericView('read src/router.js'));
  log.result(1, 1, read, '// 640 lines: notes, tags and users handlers share one file\n', { card: 'generic' });
  log.assistant(1, 2, {
    text: 'The three resources barely share code, so the split is mechanical. The plan is below for your review.',
    usage: { inputTokens: 200, outputTokens: 340, cacheReadTokens: 4300, cacheWriteTokens: 0 },
  });
  log.turnEnd(1);
  return log.events;
}

// ---------- the world ----------

const summed = (events) => {
  const total = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const { event } of events) {
    const u = event.type === 'assistant/message' && event.data.usage;
    if (!u) continue;
    total.uncachedInputTokens += u.inputTokens || 0;
    total.outputTokens += u.outputTokens || 0;
    total.cacheReadTokens += u.cacheReadTokens || 0;
    total.cacheWriteTokens += u.cacheWriteTokens || 0;
  }
  return total;
};

const lastSeq = (events) => (events.length ? events[events.length - 1].event.seq : -1);

/**
 * The demo world at `now`: host snapshot, session rows, histories, jobs, subagents,
 * and the frames the mux replays on open. Pure data; scripts/demo-dsh.mjs serves it.
 */
export function buildDemo(now = Date.now()) {
  const paginationTurnAt = now - (4 * MIN + 12 * 1000);
  const tomlTurnAt = now - (1 * MIN + 41 * 1000);
  const pag = paginationLog(now, paginationTurnAt);
  const histories = new Map([
    [ID.pagination, pag.events],
    [ID.toml, tomlLog(tomlTurnAt)],
    [ID.offByOne, offByOneLog(now)],
    [ID.router, routerLog(now)],
  ]);

  const todos = {
    [ID.pagination]: [
      { content: 'Read the route handler', status: 'completed' },
      { content: 'Add the cursor query parameter', status: 'completed' },
      { content: 'Answer from afterCursor when it is set', status: 'completed' },
      { content: 'Build and run the test suite', status: 'in_progress' },
      { content: 'Document the parameter in the README', status: 'pending' },
    ],
    [ID.toml]: [
      { content: 'Read the current loader', status: 'completed' },
      { content: 'Add a TOML parser path', status: 'in_progress' },
      { content: 'Warn when a JSON file is loaded', status: 'pending' },
      { content: 'Update the loader tests', status: 'pending' },
    ],
  };
  const pressure = {
    [ID.pagination]: { pressureTokens: 83_500, projectedTokens: 84_200, contextWindow: 200_000 },
    [ID.toml]: { pressureTokens: 154_000, projectedTokens: 156_400, contextWindow: 200_000 },
    [ID.offByOne]: { pressureTokens: 38_400, projectedTokens: 39_100, contextWindow: 200_000 },
  };

  const lastTime = (events, fallback) => {
    const last = events && events.length ? events[events.length - 1].event : null;
    return last && typeof last.time === 'number' ? last.time : fallback;
  };
  // [id, title, cwd, updatedAt, running]
  const rows = [
    [ID.toml, 'Migrate the config loader to TOML', '/work/demo/config-lib', tomlTurnAt, true],
    [ID.pagination, 'Add cursor pagination to GET /notes', NOTES, paginationTurnAt, true],
    // updatedAt is when the log last moved, not when it began, so the row's age matches the chat.
    [ID.offByOne, 'Fix the off-by-one in paginate()', NOTES, lastTime(histories.get(ID.offByOne), now - 26 * MIN), false],
    [ID.router, 'Plan the router split', NOTES, now - 75 * MIN, false],
    [ID.lint, 'Bump the lint config to the flat format', '/work/demo/web-shell', now - 3 * HOUR, false],
    [ID.backoff, 'Explain the retry backoff in the queue worker', '/work/demo/queue-worker', now - 1 * DAY - 2 * HOUR, false],
    [ID.helpers, 'Rename utils/ to helpers/', '/work/demo/web-shell', now - 2 * DAY, false],
    [ID.notes, 'Draft the 0.4 release notes', NOTES, now - 5 * DAY, false],
  ];
  const sessions = rows.map(([sessionId, title, cwd, updatedAt, running]) => {
    const values = { title, sessionListMetadata: { blank: false, lastPromptAt: updatedAt } };
    if (todos[sessionId]) values.todos = todos[sessionId];
    if (pressure[sessionId]) values.contextPressure = pressure[sessionId];
    const history = histories.get(sessionId);
    return {
      sessionId, updatedAt, running, blank: false, cwd, agentPreset: 'standard',
      projections: { asOfSeq: history ? lastSeq(history) : 0, values },
    };
  });

  // The session.history tail block: title, context fill and the session token totals,
  // which are the sum of the per-step usage in the log so the two always agree.
  const historyProjections = (sessionId) => {
    const row = sessions.find((s) => s.sessionId === sessionId);
    const history = histories.get(sessionId) || [];
    const values = { ...row.projections.values };
    if (history.some((e) => e.event.type === 'assistant/message')) values.tokenUsage = summed(history);
    return { asOfSeq: lastSeq(history), values };
  };

  const jobs = {
    [ID.pagination]: [
      { id: 'bash-1', kind: 'bash', label: 'npm run dev', status: 'running', startedAt: now - (3 * MIN + 5 * 1000) },
      { id: 'bash-2', kind: 'bash', label: 'npm run lint', status: 'completed', detail: 'exit code: 0', startedAt: now - 6 * MIN, finishedAt: now - 5 * MIN },
    ],
  };
  // subagent.list: the direct-child catalog (subagents.d.ts). Timing rides the
  // `subagentTiming` projection of each child.
  const subagents = {
    [ID.pagination]: {
      parentAvailable: true,
      entries: [
        { kind: 'child', id: ID.subTests, mode: 'one-shot', label: 'Write tests for the cursor branch', activity: 'running', hasChildren: false },
        { kind: 'child', id: ID.subSurvey, mode: 'one-shot', label: 'Survey the other list endpoints', activity: 'inactive', hasChildren: false },
      ],
    },
  };
  const timing = {
    [ID.subTests]: { settledMs: 0, active: { since: now - (1 * MIN + 35 * 1000), through: now } },
    [ID.subSurvey]: { settledMs: 41_000 },
  };

  const models = {
    current: { provider: PROVIDER, model: MODEL },
    routable: true,
    groups: [{
      id: PROVIDER,
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    }],
    failures: [],
  };

  return {
    now,
    describe: {
      version: '0.0.0-demo', cwd: '/work/demo', provider: PROVIDER, model: MODEL,
      attachedSessions: 4, home: '/srv/demo-home', canOpenPath: false,
    },
    sessions,
    histories,
    historyProjections,
    jobs,
    subagents,
    timing,
    models,
    workspace: { items: [], archivedSessionIds: [] },
    approval: {
      rpcId: APPROVAL_RPC,
      payload: {
        type: 'approval/requested', sessionId: ID.pagination, approvalId: 'demo-approval',
        toolName: 'bash', callId: pag.build.id, reason: 'This command is not on the allow list.',
      },
    },
    plan: {
      rpcId: PLAN_RPC,
      payload: {
        type: 'question/requested', sessionId: ID.router,
        questions: [{
          id: 'plan-review',
          header: 'Plan',
          question: 'Approve this plan?',
          detail: PLAN_MD,
          options: [
            { label: 'Approve', description: 'Leave plan mode and make the changes.' },
            { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
          ],
          intent: { kind: 'plan-review', approve: 'Approve' },
        }],
      },
    },
  };
}
