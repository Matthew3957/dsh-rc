// server/claude-transcripts.mjs: matching, tailing and summarising Claude Code transcripts.
// Every transcript here is synthetic, written into a temp dir with made-up UUIDs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_EVENTS, SUMMARY_CAP, TEXT_CAP,
  createClaudeTranscripts, eventsFromLines, eventsFromRecord, headOf, projectDirNames, readTranscript, shortPath, summarizeTool,
} from '../server/claude-transcripts.mjs';

const quiet = { log() {}, error() {} };
const CWD = '/work/demo';
const PROJECT = '-work-demo';
const T0 = Date.parse('2026-01-02T03:04:05.000Z');
const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const U3 = '00000000-0000-4000-8000-000000000003';

const iso = (ms) => new Date(ms).toISOString();
const prompt = (at, text = 'Synthetic task: tidy the parser', over = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: iso(at), cwd: CWD, sessionId: 'x', entrypoint: 'sdk-cli', ...over });
const say = (at, text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, timestamp: iso(at), cwd: CWD });
const use = (at, id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, timestamp: iso(at), cwd: CWD });
const result = (at, id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, timestamp: iso(at), cwd: CWD });
const jsonl = (...recs) => recs.map((r) => JSON.stringify(r) + '\n').join('');

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rc-claude-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function writeTranscript(configDir, uuid, body, project = PROJECT) {
  const dir = path.join(configDir, 'projects', project);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, uuid + '.jsonl');
  await fsp.writeFile(file, body);
  return file;
}

// ---------- pure helpers ----------

test('a cwd maps to one directory name under projects/, never a path that leaves it', () => {
  assert.deepEqual(projectDirNames('/work/demo'), ['-work-demo']);
  assert.deepEqual(projectDirNames('/work/my_app.v2'), ['-work-my-app-v2', '-work-my_app.v2']);
  for (const bad of ['', 'work/demo', '..', '/work/\0x', null, 7, '/' + 'a'.repeat(5000)]) assert.deepEqual(projectDirNames(bad), [], String(bad).slice(0, 20));
  for (const name of projectDirNames('/../../etc')) {
    assert.ok(!name.includes('/'));
    assert.ok(name !== '..' && name !== '.');
  }
});

test('tool calls become one short line each, never their full input', () => {
  assert.equal(summarizeTool('Bash', { command: 'npm test\n  && echo done', description: 'Run tests' }, CWD), 'Bash: npm test && echo done');
  assert.equal(summarizeTool('Read', { file_path: '/work/demo/public/app.js' }, CWD), 'Read: public/app.js');
  assert.equal(summarizeTool('Edit', { file_path: '/elsewhere/deep/dir/file.txt', old_string: 'x'.repeat(5000), new_string: 'y' }, CWD), 'Edit: …/dir/file.txt');
  assert.equal(summarizeTool('Grep', { pattern: 'foo', path: '/work/demo/server' }, CWD), 'Grep: foo in server');
  assert.equal(summarizeTool('Glob', { pattern: '**/*.mjs' }, CWD), 'Glob: **/*.mjs');
  assert.equal(summarizeTool('WebFetch', { url: 'https://example.com/docs/page?q=secret' }, CWD), 'WebFetch: example.com/docs/page');
  assert.equal(summarizeTool('WebSearch', { query: 'node test runner' }, CWD), 'WebSearch: node test runner');
  assert.equal(summarizeTool('Task', { description: 'Survey the tests', prompt: 'long brief' }, CWD), 'Task: Survey the tests');
  assert.equal(summarizeTool('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'Patch it', status: 'in_progress' }] }, CWD), 'TodoWrite: 2 items · Patch it');
  assert.equal(summarizeTool('mcp__x__thing', { arg: 'value' }, CWD), 'mcp__x__thing: value');
  assert.equal(summarizeTool('Write', {}, CWD), 'Write');
  const long = summarizeTool('Bash', { command: 'echo ' + 'z'.repeat(1000) }, CWD);
  assert.equal(long.length, SUMMARY_CAP);
  assert.ok(long.endsWith('…'));
  assert.equal(shortPath('/work/demo', CWD), '.');
  assert.equal(shortPath('relative/x', CWD), 'relative/x');
});

test('records reduce to text, tool calls and tool outcomes; thinking and housekeeping vanish', () => {
  const thinking = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private chain' }, { type: 'text', text: 'Looking now.' }] }, timestamp: iso(T0) };
  assert.deepEqual(eventsFromRecord(thinking), [{ k: 'text', text: 'Looking now.', at: T0 }]);
  assert.deepEqual(eventsFromRecord(use(T0, 'tu1', 'Bash', { command: 'ls' })), [{ k: 'tool', id: 'tu1', text: 'Bash: ls', at: T0 }]);
  assert.deepEqual(eventsFromRecord(result(T0, 'tu1', 'file contents that must not travel')), [{ k: 'result', id: 'tu1', ok: true, at: T0 }]);
  assert.deepEqual(eventsFromRecord(result(T0, 'tu2', [{ type: 'text', text: '\nExit code 1\nmore detail' }], true)), [{ k: 'result', id: 'tu2', ok: false, at: T0, text: 'Exit code 1' }]);
  for (const r of [prompt(T0), { type: 'file-history-snapshot', snapshot: {} }, { type: 'queue-operation' }, { type: 'attachment' }, { ...say(T0, 'side'), isSidechain: true }, null, 'x']) {
    assert.deepEqual(eventsFromRecord(r), []);
  }
  const [long] = eventsFromRecord(say(T0, 'w '.repeat(1000)));
  assert.equal(long.text.length, TEXT_CAP);
  assert.deepEqual(eventsFromLines('{broken\n' + JSON.stringify(say(T0, 'ok')) + '\n\n'), [{ k: 'text', text: 'ok', at: T0 }]);
});

test('the head of a transcript is its first real prompt', () => {
  const head = headOf(jsonl({ type: 'summary', summary: 's' }, prompt(T0, 'First ask'), prompt(T0 + 5, 'Second ask')));
  assert.deepEqual(head, { startedAt: T0, prompt: 'First ask', entrypoint: 'sdk-cli' });
  assert.equal(headOf(jsonl({ type: 'summary' })), null);
});

// ---------- tail and offset ----------

test('a read with no offset answers the tail, and an offset reads only what was appended', async (t) => {
  const cfg = await tempDir(t);
  const file = await writeTranscript(cfg, U1, jsonl(prompt(T0), use(T0 + 1, 'tu1', 'Read', { file_path: '/work/demo/a.js' })));
  const first = await readTranscript(file, null);
  assert.equal(first.reset, true);
  assert.deepEqual(first.events.map((e) => e.text), ['Read: a.js']);
  const { size } = await fsp.stat(file);
  assert.equal(first.offset, size);
  await fsp.appendFile(file, jsonl(result(T0 + 2, 'tu1', 'x'), say(T0 + 3, 'Done reading.')));
  const next = await readTranscript(file, first.offset);
  assert.equal(next.reset, false);
  assert.deepEqual(next.events.map((e) => e.k), ['result', 'text']);
  const idle = await readTranscript(file, next.offset);
  assert.deepEqual(idle.events, []);
  assert.equal(idle.offset, next.offset);
});

test('a half-written last line is left for the next read and then read whole', async (t) => {
  const cfg = await tempDir(t);
  const done = JSON.stringify(say(T0, 'one')) + '\n';
  const partial = JSON.stringify(say(T0 + 1, 'two'));
  const file = await writeTranscript(cfg, U1, done + partial.slice(0, 20));
  const a = await readTranscript(file, 0);
  assert.deepEqual(a.events.map((e) => e.text), ['one']);
  assert.equal(a.offset, Buffer.byteLength(done));
  await fsp.appendFile(file, partial.slice(20));
  const b = await readTranscript(file, a.offset);
  assert.deepEqual(b.events, [], 'still no line break: still waiting');
  assert.equal(b.offset, a.offset);
  await fsp.appendFile(file, '\n');
  const c = await readTranscript(file, b.offset);
  assert.deepEqual(c.events.map((e) => e.text), ['two']);
});

test('the tail starts at a line boundary, skips a gap too large to read, and resets past the end', async (t) => {
  const cfg = await tempDir(t);
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(say(T0 + i, 'line ' + i));
  const file = await writeTranscript(cfg, U1, jsonl(...lines));
  const tail = await readTranscript(file, null, { tailBytes: 2000 });
  assert.ok(tail.events.length > 0 && tail.events.length < 200);
  assert.equal(tail.events.at(-1).text, 'line 199');
  assert.match(tail.events[0].text, /^line \d+$/, 'the cut first line is dropped, not parsed half');
  const gap = await readTranscript(file, 0, { maxRead: 2000 });
  assert.equal(gap.reset, true);
  assert.equal(gap.events.at(-1).text, 'line 199');
  const { size } = await fsp.stat(file);
  const past = await readTranscript(file, size + 999);
  assert.equal(past.reset, true);
  assert.equal(past.events.length, MAX_EVENTS);
});

test('a single line longer than one read is passed over instead of stalling the feed', async (t) => {
  const cfg = await tempDir(t);
  const huge = JSON.stringify(result(T0, 'tu1', 'q'.repeat(5000))) + '\n';
  const file = await writeTranscript(cfg, U1, huge + jsonl(say(T0 + 1, 'after')));
  let r = await readTranscript(file, 0, { maxRead: 1000 });
  // The read jumped to the last 1000 bytes; it finds the line after the huge one.
  assert.deepEqual(r.events.map((e) => e.text), ['after']);
  // Reading from inside the huge line, one window at a time, also gets there.
  const { size } = await fsp.stat(file);
  let offset = 0;
  const seen = [];
  for (let i = 0; i < 20 && offset < size; i++) {
    r = await readTranscript(file, offset, { maxRead: 1000, tailBytes: 1000 });
    if (r.offset === offset) break;
    offset = r.offset;
    seen.push(...r.events.map((e) => e.text));
  }
  assert.ok(seen.includes('after'));
});

// ---------- matching runs ----------

test('runs are listed from every configured dir, nearest start first, within the window only', async (t) => {
  const a = await tempDir(t);
  const b = await tempDir(t);
  await writeTranscript(a, U1, jsonl(prompt(T0 + 4_000, 'run in dir a')));
  await writeTranscript(b, U2, jsonl(prompt(T0 + 1_000, 'run in dir b')));
  await writeTranscript(b, U3, jsonl(prompt(T0 - 600_000, 'an old run')));
  await writeTranscript(a, '00000000-0000-4000-8000-000000000004', jsonl(prompt(T0 + 2_000, 'interactive', { entrypoint: 'cli' })));
  await writeTranscript(a, 'not-a-uuid', jsonl(prompt(T0)));
  const svc = createClaudeTranscripts({ configDirs: [a, b], logger: quiet });
  const runs = await svc.listRuns(CWD, T0);
  assert.deepEqual(runs.map((r) => r.prompt), ['run in dir b', 'run in dir a']);
  for (const r of runs) {
    assert.match(r.id, /^[A-Za-z0-9_-]{16}$/);
    assert.ok(!JSON.stringify(r).includes(a) && !JSON.stringify(r).includes(b), 'no config path in the answer');
  }
  // The same transcript keeps its id, and the id reads it.
  const again = await svc.listRuns(CWD, T0);
  assert.equal(again[0].id, runs[0].id);
  const view = await svc.runEvents(runs[1].id, null);
  assert.deepEqual(view.events, []);
  assert.equal(await svc.runEvents('AAAAAAAAAAAAAAAA', null), null);
  assert.equal(await svc.runEvents('../../etc/passwd', null), null);
  assert.deepEqual(await svc.listRuns('/work/other', T0), []);
});

test('symlinks below projects/ are never followed', async (t) => {
  const cfg = await tempDir(t);
  const outside = await tempDir(t);
  const secret = await writeTranscript(outside, U1, jsonl(prompt(T0, 'outside')), 'x');
  await fsp.mkdir(path.join(cfg, 'projects'), { recursive: true });
  await fsp.symlink(path.join(outside, 'projects', 'x'), path.join(cfg, 'projects', '-work-linked'));
  await fsp.mkdir(path.join(cfg, 'projects', PROJECT));
  await fsp.symlink(secret, path.join(cfg, 'projects', PROJECT, U2 + '.jsonl'));
  const svc = createClaudeTranscripts({ configDirs: [cfg], logger: quiet });
  assert.deepEqual(await svc.listRuns('/work/linked', T0), []);
  assert.deepEqual(await svc.listRuns(CWD, T0), []);
});

test('a listed run whose file turns into a symlink is no longer read', async (t) => {
  const cfg = await tempDir(t);
  const outside = await tempDir(t);
  const file = await writeTranscript(cfg, U1, jsonl(prompt(T0)));
  const svc = createClaudeTranscripts({ configDirs: [cfg], logger: quiet });
  const [run] = await svc.listRuns(CWD, T0);
  assert.ok(run);
  const other = path.join(outside, 'other.jsonl');
  await fsp.writeFile(other, jsonl(say(T0, 'not yours')));
  await fsp.rm(file);
  await fsp.symlink(other, file);
  assert.equal(await svc.runEvents(run.id, null), null);
});

test('with no config dirs the feature is off, and a relative dir is refused', async () => {
  const off = createClaudeTranscripts({ configDirs: [], logger: quiet });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.listRuns(CWD, T0), []);
  assert.throws(() => createClaudeTranscripts({ configDirs: ['relative/dir'] }), /absolute/);
});
