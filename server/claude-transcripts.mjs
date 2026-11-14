// Read-only views of Claude Code transcripts, so Running now can show what an external
// `subagent_claude_*` run is doing while it works.
//
// dsh runs those subagents as the real Claude Code CLI, which appends its transcript as JSONL
// at <CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<session uuid>.jsonl. dsh-rc only reads the
// config dirs it was given (--claude-config-dir, DSH_RC_CLAUDE_CONFIG_DIRS); with none the
// feature is off.
//
// Routes (GET/HEAD only, behind the login like /api):
//   GET /claude/runs?cwd=<abs cwd>&since=<epoch ms>
//       { enabled, runs: [{ id, startedAt, updatedAt, prompt }] }, nearest start first.
//       Only transcripts whose first prompt landed near `since` are listed. `id` is opaque,
//       minted here and only meaningful to this server process.
//   GET /claude/runs/<id>[?offset=<n>]
//       { events, offset, size, updatedAt, reset }. Without an offset (or with one past the
//       end) it answers the tail; with one, the complete lines appended since. `reset` says
//       the events replace, rather than extend, what the page had.
//
// The client never names a file: a cwd only selects one directory directly under a configured
// `projects/`, file names must be UUIDs, nothing below `projects/` may be a symlink, and every
// event is reduced to a short summary here, so full tool inputs and results never leave.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID_RE = /^[A-Za-z0-9_-]{16}$/;

/** Bytes read for a first look at a transcript, and the most one poll reads. */
export const TAIL_BYTES = 64 * 1024;
export const MAX_READ = 256 * 1024;
const HEAD_BYTES = 64 * 1024;
/** Events returned per answer, and the caps on their text. */
export const MAX_EVENTS = 40;
export const TEXT_CAP = 280;
export const SUMMARY_CAP = 140;
export const PROMPT_CAP = 160;
/** A transcript belongs to a run when its first prompt is this close to the run's start. */
export const MATCH_BEFORE_MS = 10_000;
export const MATCH_AFTER_MS = 30_000;
const MAX_RUNS = 8;
const MAX_SCAN = 400;
const MAX_IDS = 512;
const MAX_CWD = 4096;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

// ---------- Pure helpers ----------

/** Cap a string at n UTF-16 units, without leaving half a surrogate pair. */
export function cap(s, n) {
  const str = String(s == null ? '' : s);
  if (str.length <= n) return str;
  let cut = str.slice(0, n - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
}
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/**
 * Directory names Claude Code may have used for a cwd under `projects/`. Current versions
 * replace every character outside [A-Za-z0-9] with `-`; older ones replaced only `/`. Both are
 * single path segments; anything that could step out of `projects/` is dropped.
 */
export function projectDirNames(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > MAX_CWD || cwd.includes('\0')) return [];
  const out = [];
  for (const name of [cwd.replace(/[^A-Za-z0-9]/g, '-'), cwd.replace(/\//g, '-')]) {
    if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** A path as a phone line: relative inside the run's cwd, otherwise its last two segments. */
export function shortPath(p, cwd) {
  if (typeof p !== 'string' || !p) return '';
  if (typeof cwd === 'string' && cwd) {
    const root = cwd.replace(/\/+$/, '');
    if (p === root) return '.';
    if (p.startsWith(root + '/')) return p.slice(root.length + 1);
  }
  if (!p.startsWith('/')) return p;
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}

function urlShort(u) {
  try {
    const url = new URL(String(u));
    return url.host + (url.pathname === '/' ? '' : url.pathname);
  } catch {
    return String(u || '');
  }
}

/** One short, human-readable line for a tool call: never its full input. */
export function summarizeTool(name, input, cwd) {
  const n = typeof name === 'string' && name ? name : 'tool';
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const rel = (p) => shortPath(str(p), cwd);
  let detail = '';
  switch (n) {
    case 'Bash': detail = str(a.command) || str(a.description); break;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': detail = rel(a.file_path); break;
    case 'NotebookEdit': case 'NotebookRead': detail = rel(a.notebook_path); break;
    case 'Grep': detail = str(a.pattern) + (a.path ? ' in ' + rel(a.path) : a.glob ? ' in ' + str(a.glob) : ''); break;
    case 'Glob': detail = str(a.pattern) + (a.path ? ' in ' + rel(a.path) : ''); break;
    case 'LS': detail = rel(a.path); break;
    case 'WebSearch': detail = str(a.query); break;
    case 'WebFetch': detail = urlShort(a.url); break;
    case 'Task': case 'Agent': detail = str(a.description) || str(a.subagent_type); break;
    case 'TodoWrite': {
      const todos = Array.isArray(a.todos) ? a.todos : [];
      const current = todos.find((t) => t && t.status === 'in_progress');
      detail = `${todos.length} item${todos.length === 1 ? '' : 's'}` + (current && current.content ? ' · ' + str(current.content) : '');
      break;
    }
    default:
      for (const v of Object.values(a)) if (typeof v === 'string' && v.trim()) { detail = v; break; }
  }
  detail = oneLine(detail);
  return cap(detail ? `${n}: ${detail}` : n, SUMMARY_CAP);
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text;
  return '';
}

/**
 * The events one transcript record contributes: assistant text, tool calls, and the outcome
 * of a tool call (only whether it failed, plus a short first line when it did). Thinking,
 * prompts, attachments, snapshots and other housekeeping contribute nothing.
 */
export function eventsFromRecord(rec) {
  if (!rec || typeof rec !== 'object' || rec.isSidechain === true || rec.isMeta === true) return [];
  const msg = rec.message && typeof rec.message === 'object' ? rec.message : null;
  if (!msg || !Array.isArray(msg.content)) return [];
  const t = Date.parse(rec.timestamp);
  const at = Number.isFinite(t) ? t : null;
  const out = [];
  if (rec.type === 'assistant') {
    for (const b of msg.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push({ k: 'text', text: cap(oneLine(b.text), TEXT_CAP), at });
      } else if (b.type === 'tool_use') {
        out.push({ k: 'tool', id: cap(b.id || '', 80), text: summarizeTool(b.name, b.input, rec.cwd), at });
      }
    }
  } else if (rec.type === 'user') {
    for (const b of msg.content) {
      if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue;
      const ev = { k: 'result', id: cap(b.tool_use_id || '', 80), ok: b.is_error !== true, at };
      if (b.is_error === true) {
        const first = oneLine(textOfContent(b.content).split('\n').find((l) => l.trim()) || '');
        if (first) ev.text = cap(first, 120);
      }
      out.push(ev);
    }
  }
  return out;
}

/** Events from a buffer of complete JSONL lines; a line that is not JSON is skipped. */
export function eventsFromLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    for (const ev of eventsFromRecord(rec)) out.push(ev);
  }
  return out;
}

/** When a transcript began and what it was asked, from its first prompt record. */
export function headOf(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.type !== 'user' || rec.isMeta === true || rec.isSidechain === true) continue;
    const t = Date.parse(rec.timestamp);
    if (!Number.isFinite(t)) continue;
    const msg = rec.message && typeof rec.message === 'object' ? rec.message : {};
    return {
      startedAt: t,
      prompt: cap(oneLine(textOfContent(msg.content)), PROMPT_CAP),
      entrypoint: typeof rec.entrypoint === 'string' ? rec.entrypoint : '',
    };
  }
  return null;
}

// ---------- File access ----------

async function openFile(file) {
  const fh = await fsp.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
    return { fh, st };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

async function readAt(fh, start, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, start + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * Read the complete lines of a transcript from a byte offset. The answer's `offset` is where
 * the next read starts: just past the last complete line, so a line still being written is
 * read again whole next time. An offset in the middle of a line (the tail, or a skip past a
 * gap too big to read) drops the bytes up to the next line break.
 */
export async function readTranscript(file, offset, { tailBytes = TAIL_BYTES, maxRead = MAX_READ } = {}) {
  const { fh, st } = await openFile(file);
  try {
    const size = st.size;
    let start;
    let reset = false;
    if (offset == null || offset > size) {
      start = Math.max(0, size - tailBytes);
      reset = true;
    } else {
      start = offset;
    }
    if (size - start > maxRead) {
      start = size - maxRead;
      reset = true;
    }
    const buf = start < size ? await readAt(fh, start, size - start) : Buffer.alloc(0);
    const aligned = start === 0 || (await readAt(fh, start - 1, 1))[0] === 0x0a;
    let from = 0;
    if (!aligned) {
      const nl = buf.indexOf(0x0a);
      // All of it is the rest of a line already passed: nothing to parse, and none of it is needed.
      if (nl === -1) return { events: [], offset: start + buf.length, size, updatedAt: st.mtimeMs, reset };
      from = nl + 1;
    }
    const last = buf.lastIndexOf(0x0a);
    if (last < from) {
      // No complete line yet. A line longer than one read is passed over rather than waited on forever.
      const next = buf.length - from >= maxRead ? start + buf.length : start + from;
      return { events: [], offset: next, size, updatedAt: st.mtimeMs, reset };
    }
    const events = eventsFromLines(buf.subarray(from, last + 1).toString('utf8'));
    return { events: events.slice(-MAX_EVENTS), offset: start + last + 1, size, updatedAt: st.mtimeMs, reset };
  } finally {
    await fh.close();
  }
}

async function readHead(file) {
  const { fh, st } = await openFile(file);
  try {
    const buf = await readAt(fh, 0, Math.min(st.size, HEAD_BYTES));
    const last = buf.lastIndexOf(0x0a);
    return last === -1 ? null : headOf(buf.subarray(0, last + 1).toString('utf8'));
  } finally {
    await fh.close();
  }
}

// ---------- The service ----------

/**
 * @param {{configDirs?: string[], logger?: {error: Function}}} options
 * Each config dir must be absolute. It and its `projects/` are trusted as configured; nothing
 * below `projects/` is followed through a symlink.
 */
export function createClaudeTranscripts({ configDirs = [], logger = console } = {}) {
  const roots = [];
  for (const dir of configDirs) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error(`--claude-config-dir must be an absolute path (got ${JSON.stringify(dir)})`);
    const projects = path.join(path.resolve(dir), 'projects');
    if (!roots.includes(projects)) roots.push(projects);
  }
  const enabled = roots.length > 0;
  const byId = new Map(); // run id -> {root, name, uuid}
  const byKey = new Map(); // root\0name\0uuid -> run id
  const heads = new Map(); // file path -> {ino, head}

  function idFor(root, name, uuid) {
    const key = `${roots.indexOf(root)}\0${name}\0${uuid}`;
    let id = byKey.get(key);
    if (id && byId.has(id)) {
      // Most recently used goes last, so eviction drops the stalest.
      const ref = byId.get(id);
      byId.delete(id); byId.set(id, ref);
      return id;
    }
    id = crypto.randomBytes(12).toString('base64url');
    byId.set(id, { root, name, uuid });
    byKey.set(key, id);
    while (byId.size > MAX_IDS) {
      const [oldId, ref] = byId.entries().next().value;
      byId.delete(oldId);
      byKey.delete(`${roots.indexOf(ref.root)}\0${ref.name}\0${ref.uuid}`);
    }
    return id;
  }

  /** The project directory for a name, or null unless it is a real directory right under root. */
  async function projectDir(root, name) {
    const dir = path.join(root, name);
    if (path.dirname(dir) !== root) return null;
    try {
      const st = await fsp.lstat(dir);
      return st.isDirectory() && !st.isSymbolicLink() ? dir : null;
    } catch {
      return null;
    }
  }

  /** Transcript file for a uuid, or null unless it is a regular file (not a symlink). */
  async function transcriptFile(dir, uuid) {
    if (!UUID_RE.test(uuid)) return null;
    const file = path.join(dir, uuid + '.jsonl');
    try {
      const st = await fsp.lstat(file);
      return st.isFile() ? { file, st } : null;
    } catch {
      return null;
    }
  }

  async function headFor(file, st) {
    const cached = heads.get(file);
    if (cached && cached.ino === st.ino) return cached.head;
    const head = await readHead(file).catch(() => null);
    // A transcript whose first prompt is not written yet is looked at again next time.
    if (head) {
      heads.set(file, { ino: st.ino, head });
      if (heads.size > MAX_IDS * 2) heads.delete(heads.keys().next().value);
    }
    return head;
  }

  /** Transcripts in `cwd` whose first prompt landed near `since`, nearest first. */
  async function listRuns(cwd, since) {
    if (!enabled) return [];
    const names = projectDirNames(cwd);
    const found = [];
    for (const root of roots) {
      for (const name of names) {
        const dir = await projectDir(root, name);
        if (!dir) continue;
        let entries;
        try {
          entries = await fsp.readdir(dir);
        } catch {
          continue;
        }
        let scanned = 0;
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) continue;
          const uuid = entry.slice(0, -'.jsonl'.length);
          if (!UUID_RE.test(uuid)) continue;
          if (++scanned > MAX_SCAN) break;
          const hit = await transcriptFile(dir, uuid);
          // A transcript that started near `since` has been written to since then.
          if (!hit || hit.st.mtimeMs < since - MATCH_BEFORE_MS) continue;
          const head = await headFor(hit.file, hit.st);
          if (!head) continue;
          // Interactive Claude Code in the same folder is not a dsh subagent run.
          if (head.entrypoint === 'cli') continue;
          const delta = head.startedAt - since;
          if (delta < -MATCH_BEFORE_MS || delta > MATCH_AFTER_MS) continue;
          found.push({ root, name, uuid, startedAt: head.startedAt, updatedAt: hit.st.mtimeMs, prompt: head.prompt, distance: Math.abs(delta) });
        }
      }
    }
    found.sort((a, b) => a.distance - b.distance);
    return found.slice(0, MAX_RUNS).map((r) => ({ id: idFor(r.root, r.name, r.uuid), startedAt: r.startedAt, updatedAt: r.updatedAt, prompt: r.prompt }));
  }

  /** The events of one listed run, or null for an id this process never minted. */
  async function runEvents(id, offset) {
    if (!enabled || !RUN_ID_RE.test(String(id))) return null;
    const ref = byId.get(id);
    if (!ref) return null;
    const dir = await projectDir(ref.root, ref.name);
    if (!dir) return null;
    const hit = await transcriptFile(dir, ref.uuid);
    if (!hit) return null;
    try {
      return await readTranscript(hit.file, offset);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ELOOP' || err.code === 'ENOTFILE')) return null;
      throw err;
    }
  }

  function send(req, res, status, value, extra = {}) {
    const buf = Buffer.from(JSON.stringify(value), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    return req.method === 'HEAD' ? res.end() : res.end(buf);
  }

  /** Answer one /claude/* request. Auth and the Host/Origin checks happen before this. */
  async function handle(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return send(req, res, 400, { error: 'bad request' });
    }
    if (pathname === '/claude/runs') {
      if (!enabled) return send(req, res, 200, { enabled: false, runs: [] });
      const cwd = url.searchParams.get('cwd');
      const since = Number(url.searchParams.get('since'));
      if (!projectDirNames(cwd).length) return send(req, res, 400, { error: 'cwd must be an absolute path' });
      if (!Number.isFinite(since) || since <= 0) return send(req, res, 400, { error: 'since must be a time in milliseconds' });
      try {
        return send(req, res, 200, { enabled: true, runs: await listRuns(cwd, since) });
      } catch (err) {
        logger.error(`[dsh-rc] listing Claude transcripts failed: ${(err && err.code) || 'error'}`);
        return send(req, res, 500, { error: 'could not list transcripts' });
      }
    }
    const m = /^\/claude\/runs\/([^/]+)$/.exec(pathname);
    if (!m || !RUN_ID_RE.test(m[1])) return send(req, res, 404, { error: 'not found' });
    let offset = null;
    if (url.searchParams.has('offset')) {
      const raw = url.searchParams.get('offset');
      offset = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(offset)) return send(req, res, 400, { error: 'offset must be a whole number of bytes' });
    }
    let view;
    try {
      view = await runEvents(m[1], offset);
    } catch (err) {
      logger.error(`[dsh-rc] reading a Claude transcript failed: ${(err && err.code) || 'error'}`);
      return send(req, res, 500, { error: 'could not read the transcript' });
    }
    if (!view) return send(req, res, 404, { error: 'unknown run' });
    return send(req, res, 200, view);
  }

  return { enabled, dirCount: roots.length, listRuns, runEvents, handle };
}
