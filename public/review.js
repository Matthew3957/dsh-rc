// Reviewing what a turn did: line diffs for dsh's `diff` tool cards, a per-turn
// summary (files changed, commands run, pass or fail), and the plan-mode review
// question. Pure functions with no DOM, so the tests import this file directly.
//
// The shapes come from dsh itself:
//   - a tool view is `{ card, ... }` (dsh-host-apiproxy's toolEventViewSchema);
//     inside it, dsh-tools' presentation vocabulary: `card: 'diff'` carries
//     `diffs: [{ path, oldText | null, newText }]`, and `card: 'terminal'` a
//     command `title` on the call and `exitCode` / `signal` on the result;
//   - `turn/end` carries `reason.kind` (completed, aborted, blocked, error,
//     max-tokens, interrupted), from dsh-session's TurnEndReasonMap;
//   - a plan review is a question whose `intent` is `{ kind: 'plan-review',
//     approve }` (askUserQuestionItemSchema), with the plan in `detail`.

// Past this many cells the middle of a change is shown as removed-then-added
// rather than aligned: a phone should not spend seconds on one card.
const MAX_CELLS = 1_000_000;
// Bounds on what a diff keeps at all, so a huge generated file cannot build a
// million-entry array on a phone: unchanged runs keep EDGE lines next to the
// change, and a changed middle keeps MAX_CHANGED lines per side. Counts stay exact.
const EDGE = 50;
const MAX_CHANGED = 1000;

function lines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop(); // a trailing newline ends the last line, it does not start one
  return out;
}

/**
 * Line diff of two texts as `[{ op: ' ' | '-' | '+', text }]`. `oldText` null
 * (a created or overwritten file, where dsh has no before-image) is all additions.
 */
export function diffLines(oldText, newText) {
  const a = lines(oldText), b = lines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [];
  const from = Math.max(0, start - EDGE);
  if (from) ops.push({ op: 'skip', count: from });
  for (let i = from; i < start; i++) ops.push({ op: ' ', text: a[i] });
  const n = endA - start, m = endB - start;
  if (n > MAX_CHANGED || m > MAX_CHANGED) {
    for (let i = 0; i < Math.min(n, MAX_CHANGED); i++) ops.push({ op: '-', text: a[start + i] });
    for (let j = 0; j < Math.min(m, MAX_CHANGED); j++) ops.push({ op: '+', text: b[start + j] });
    const cut = Math.max(0, n - MAX_CHANGED) + Math.max(0, m - MAX_CHANGED);
    if (cut) ops.push({ op: 'cut', count: cut });
    ops.stats = { adds: m, dels: n }; // too big to align: every changed line counts, including the ones cut
  } else if (n && m && n * m <= MAX_CELLS) {
    // Longest common subsequence over the changed middle, walked forwards.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { ops.push({ op: ' ', text: a[start + i] }); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) { ops.push({ op: '-', text: a[start + i] }); i++; }
      else { ops.push({ op: '+', text: b[start + j] }); j++; }
    }
    for (; i < n; i++) ops.push({ op: '-', text: a[start + i] });
    for (; j < m; j++) ops.push({ op: '+', text: b[start + j] });
  } else {
    for (let i = start; i < endA; i++) ops.push({ op: '-', text: a[i] });
    for (let j = start; j < endB; j++) ops.push({ op: '+', text: b[j] });
  }
  const to = Math.min(a.length, endA + EDGE);
  for (let i = endA; i < to; i++) ops.push({ op: ' ', text: a[i] });
  if (a.length > to) ops.push({ op: 'skip', count: a.length - to });
  return ops;
}

/** Added and removed line counts of a diff. */
export function diffStats(ops) {
  if (ops && ops.stats) return { ...ops.stats };
  let adds = 0, dels = 0;
  for (const o of ops) { if (o.op === '+') adds++; else if (o.op === '-') dels++; }
  return { adds, dels };
}

/**
 * Folds unchanged runs longer than twice `context` into `{ op: 'skip', count }`,
 * keeping `context` lines either side of every change.
 */
export function foldContext(ops, context = 3) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op !== ' ') { out.push(ops[i++]); continue; }
    let j = i;
    while (j < ops.length && ops[j].op === ' ') j++;
    const run = ops.slice(i, j);
    const head = i === 0 ? 0 : context;          // nothing before to give context to
    const tail = j === ops.length ? 0 : context; // nothing after
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head), { op: 'skip', count: run.length - head - tail }, ...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

const cardOf = (view, card) => (view && typeof view === 'object' && view.card === card ? view : null);

/**
 * The diffs to draw for a tool call, or null for the generic card. Mirrors dsh's
 * own rule: once the call has settled, the result view is authoritative (the
 * applied hunks), and a settled call whose result view is not a diff (how
 * write and edit report a failure) stays generic. Until then, the call view
 * shows the intended change.
 */
export function diffsOf(tool) {
  if (!tool) return null;
  if (tool.done && tool.isError && !cardOf(tool.rview, 'diff')) return null; // a failed write changed nothing
  const view = tool.done && tool.rview ? cardOf(tool.rview, 'diff') : cardOf(tool.view, 'diff');
  if (!view || !Array.isArray(view.diffs)) return null;
  const diffs = view.diffs.filter((d) => d && typeof d.path === 'string' && typeof d.newText === 'string');
  return diffs.length ? diffs : null;
}

/** Whether a tool call is a shell command (a terminal card on either side). */
export function isCommand(tool) {
  return !!(tool && (cardOf(tool.view, 'terminal') || cardOf(tool.rview, 'terminal')));
}

/** A settled command failed: an error result, a non-zero exit, or a signal. */
export function commandFailed(tool) {
  if (tool.isError) return true;
  const r = cardOf(tool.rview, 'terminal');
  if (!r) return false;
  return (typeof r.exitCode === 'number' && r.exitCode !== 0) || (typeof r.signal === 'string' && !!r.signal);
}

/**
 * What one turn did, from its tool calls (in call order) and the `turn/end`
 * reason. `outcome` is 'passed' when the turn completed and its last command
 * (if it ran any) succeeded, 'failed' when the turn errored, was blocked, or
 * its last command failed, and 'stopped' when it was cancelled or cut short.
 * Only the last command decides, so a test that failed and was then fixed and
 * rerun within the turn reads as passed.
 */
export function summarizeTurn(tools, reason) {
  const files = new Map(); // path -> {path, adds, dels, callIds}
  const commands = [];
  for (const t of tools || []) {
    if (!t) continue;
    // An orphan (interrupted before its result) only ever shows the intended change: not a file change.
    const diffs = t.done && !t.isError && !t.orphan ? diffsOf(t) : null;
    if (diffs) {
      for (const d of diffs) {
        const { adds, dels } = diffStats(diffLines(d.oldText, d.newText));
        const f = files.get(d.path) || { path: d.path, adds: 0, dels: 0, callIds: [] };
        f.adds += adds; f.dels += dels;
        if (!f.callIds.includes(t.id)) f.callIds.push(t.id);
        files.set(d.path, f);
      }
    } else if (isCommand(t)) {
      const call = cardOf(t.view, 'terminal');
      const res = cardOf(t.rview, 'terminal');
      commands.push({
        callId: t.id,
        title: (call && call.title) || (res && res.title) || '',
        done: !!t.done,
        failed: !!t.done && commandFailed(t),
        exitCode: res && typeof res.exitCode === 'number' ? res.exitCode : null,
        signal: res && typeof res.signal === 'string' ? res.signal : null,
      });
    }
  }
  const kind = reason && reason.kind;
  const last = commands[commands.length - 1];
  let outcome, why;
  if (kind === 'error') { outcome = 'failed'; why = (reason.error && reason.error.message) || 'the turn failed'; }
  else if (kind === 'blocked') { outcome = 'failed'; why = 'the turn was blocked'; }
  else if (kind === 'aborted' || kind === 'interrupted') { outcome = 'stopped'; why = 'the turn was interrupted'; }
  else if (kind === 'max-tokens') { outcome = 'stopped'; why = 'the output limit was reached'; }
  else if (last && last.failed) { outcome = 'failed'; why = 'the last command ' + (last.signal ? 'was killed by ' + last.signal : 'exited ' + (last.exitCode ?? 'with an error')); }
  else { outcome = 'passed'; why = last ? 'the last command succeeded' : ''; }
  let adds = 0, dels = 0;
  for (const f of files.values()) { adds += f.adds; dels += f.dels; }
  return { files: [...files.values()], commands, adds, dels, failedCommands: commands.filter((c) => c.failed).length, outcome, why };
}

/**
 * The plan review inside a question batch, or null. The same narrowing dsh's web
 * UI applies before it draws a plan card: a single single-select question whose
 * intent is plan-review, that carries the plan in `detail`, has at most two
 * options, and offers the approve label it names. Anything else stays an
 * ordinary question.
 */
export function planReviewOf(questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const q = questions[0];
  const intent = q && q.intent;
  if (!intent || intent.kind !== 'plan-review' || typeof q.detail !== 'string') return null;
  if (q.multiSelect === true) return null;
  const options = q.options || [];
  if (options.length > 2) return null;
  const approve = options.find((o) => o.label === intent.approve);
  if (!approve) return null;
  const decline = options.find((o) => o.label !== intent.approve) || null;
  return { id: q.id, question: q.question, plan: q.detail, approve, decline };
}

/**
 * The answer batch for a plan review. Approving sends the approve label alone;
 * dsh treats any typed text as feedback, which keeps planning, so feedback only
 * ever rides with the decline label.
 */
export function planAnswer(review, approve, feedback = '') {
  if (approve) return { answers: [{ id: review.id, selected: [review.approve.label] }] };
  const a = { id: review.id, selected: review.decline ? [review.decline.label] : [] };
  const text = String(feedback || '').trim();
  if (text) a.custom = text;
  return { answers: [a] };
}

// app.js is a classic script and cannot import this module, so hand it the
// functions. Absent in Node, where the tests import the file directly.
if (typeof window !== 'undefined') {
  window.dshReview = { diffLines, diffStats, foldContext, diffsOf, isCommand, commandFailed, summarizeTurn, planReviewOf, planAnswer };
}
