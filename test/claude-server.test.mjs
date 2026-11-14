// The /claude/* endpoints inside startServer: configuration, the login gate, the Host and
// Origin fence, read-only methods and the resolution that keeps reads inside configured dirs.
// Transcripts are synthetic and live in temp dirs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startServer, parseCliArgs } from '../server/index.mjs';
import { savePassphrase } from '../server/auth.mjs';

const quiet = { log() {}, error() {} };
const PASSPHRASE = 'correct horse battery';
const CWD = '/work/demo';
const T0 = Date.parse('2026-01-02T03:04:05.000Z');
const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000b2';
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (...recs) => recs.map((r) => JSON.stringify(r) + '\n').join('');
const prompt = (at, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: iso(at), cwd: CWD, entrypoint: 'sdk-cli' });
const bash = (at, id, command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }, timestamp: iso(at), cwd: CWD });

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rc-claude-srv-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function writeTranscript(cfg, uuid, body, project = '-work-demo') {
  const dir = path.join(cfg, 'projects', project);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, uuid + '.jsonl'), body);
  return path.join(dir, uuid + '.jsonl');
}
async function tempServer(t, options = {}) {
  const stateDir = options.stateDir || (await tempDir(t));
  const app = await startServer({ port: 0, host: '127.0.0.1', stateDir, sender: { send: async () => {} }, watch: false, logger: quiet, ...options });
  t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${app.port}` };
}
const runsUrl = (base, cwd = CWD, since = T0) => `${base}/claude/runs?cwd=${encodeURIComponent(cwd)}&since=${since}`;

function rawRequest(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(lines.join('\r\n') + '\r\n\r\n'));
    let data = '';
    socket.on('data', (c) => { data += c.toString('utf8'); });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); resolve(data); }, 2000);
  });
}

test('--claude-config-dir repeats, and DSH_RC_CLAUDE_CONFIG_DIRS is a comma list', async (t) => {
  assert.deepEqual(parseCliArgs(['--claude-config-dir', '/cfg/a', '--claude-config-dir', '/cfg/b']).claudeConfigDirs, ['/cfg/a', '/cfg/b']);
  assert.throws(() => parseCliArgs(['--claude-config-dir']), /needs a value/);
  const a = await tempDir(t);
  const b = await tempDir(t);
  await writeTranscript(b, U2, jsonl(prompt(T0 + 1000, 'from the env dir')));
  const { base } = await tempServer(t, { env: { DSH_RC_CLAUDE_CONFIG_DIRS: `${a}, ${b}` } });
  const body = await (await fetch(runsUrl(base))).json();
  assert.equal(body.enabled, true);
  assert.deepEqual(body.runs.map((r) => r.prompt), ['from the env dir']);
  await assert.rejects(startServer({ port: 0, stateDir: await tempDir(t), watch: false, logger: quiet, env: {}, claudeConfigDirs: ['not/absolute'] }), /absolute/);
});

test('with no config dir the endpoints say so and read nothing', async (t) => {
  const { base } = await tempServer(t, { env: {} });
  const res = await fetch(runsUrl(base));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { enabled: false, runs: [] });
  assert.equal((await fetch(base + '/claude/runs/AAAAAAAAAAAAAAAA')).status, 404);
});

test('a listed run streams its summarised events by offset, with no-store and no paths', async (t) => {
  const cfg = await tempDir(t);
  const file = await writeTranscript(cfg, U1, jsonl(prompt(T0 + 2000, 'Synthetic brief'), bash(T0 + 3000, 'tu1', 'npm test')));
  const { base } = await tempServer(t, { claudeConfigDirs: [cfg] });
  const listed = await (await fetch(runsUrl(base))).json();
  assert.equal(listed.runs.length, 1);
  const { id } = listed.runs[0];
  const raw = JSON.stringify(listed);
  assert.ok(!raw.includes(cfg) && !raw.includes(U1), 'neither the config dir nor the session id leaves the server');

  const first = await fetch(`${base}/claude/runs/${id}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  const view = await first.json();
  assert.equal(view.reset, true);
  assert.deepEqual(view.events.map((e) => e.text), ['Bash: npm test']);
  assert.ok(!JSON.stringify(view).includes(cfg));

  await fsp.appendFile(file, jsonl(bash(T0 + 4000, 'tu2', 'npm run lint')) + '{"type":"assistant","mess');
  const next = await (await fetch(`${base}/claude/runs/${id}?offset=${view.offset}`)).json();
  assert.equal(next.reset, false);
  assert.deepEqual(next.events.map((e) => e.text), ['Bash: npm run lint']);
  assert.ok(next.offset < next.size, 'the half-written line is not consumed');

  const head = await fetch(`${base}/claude/runs/${id}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('only GET and HEAD are answered', async (t) => {
  const cfg = await tempDir(t);
  await writeTranscript(cfg, U1, jsonl(prompt(T0, 'x')));
  const { base } = await tempServer(t, { claudeConfigDirs: [cfg] });
  const { runs: [run] } = await (await fetch(runsUrl(base))).json();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await fetch(`${base}/claude/runs/${run.id}`, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  }
  const cross = await fetch(`${base}/claude/runs/${run.id}`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});

test('ids, cwds and offsets the server did not mint or cannot place are refused', async (t) => {
  const cfg = await tempDir(t);
  await writeTranscript(cfg, U1, jsonl(prompt(T0, 'x')));
  const outside = await tempDir(t);
  await writeTranscript(outside, U2, jsonl(prompt(T0, 'outside')), 'evil');
  const { app, base } = await tempServer(t, { claudeConfigDirs: [cfg] });
  const { runs: [run] } = await (await fetch(runsUrl(base))).json();

  // Not a minted id, not an id shape, or an attempt to name a file.
  for (const p of ['/claude/runs/AAAAAAAAAAAAAAAA', `/claude/runs/${U1}`, '/claude/runs/..%2F..%2Fetc%2Fpasswd', `/claude/runs/${run.id}/x`, '/claude/other', '/claude']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  const traversal = await rawRequest(app.port, [`GET /claude/runs/../../projects/-work-demo/${U1}.jsonl HTTP/1.1`, `Host: 127.0.0.1:${app.port}`, 'Connection: close']);
  assert.match(traversal, /^HTTP\/1\.1 404/);

  // A cwd is only ever one directory name under projects/.
  for (const cwd of ['relative', '../..', '']) assert.equal((await fetch(runsUrl(base, cwd))).status, 400, cwd);
  for (const cwd of ['/../../' + path.basename(outside) + '/projects/evil', outside + '/projects/evil']) {
    const body = await (await fetch(runsUrl(base, cwd))).json();
    assert.deepEqual(body.runs, [], cwd);
  }
  assert.equal((await fetch(runsUrl(base, CWD, 'soon'))).status, 400);
  for (const off of ['-1', '1e3', 'abc', '99999999999999999']) {
    assert.equal((await fetch(`${base}/claude/runs/${run.id}?offset=${off}`)).status, 400, off);
  }
});

test('behind a passphrase the endpoints need the login cookie', async (t) => {
  const cfg = await tempDir(t);
  await writeTranscript(cfg, U1, jsonl(prompt(T0, 'x')));
  const stateDir = await tempDir(t);
  savePassphrase(stateDir, PASSPHRASE);
  const { base } = await tempServer(t, { stateDir, claudeConfigDirs: [cfg] });
  const anon = await fetch(runsUrl(base));
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get('x-dsh-rc-login'), '1');
  assert.equal((await fetch(base + '/claude/runs/AAAAAAAAAAAAAAAA')).status, 401);
  const login = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'passphrase=' + encodeURIComponent(PASSPHRASE), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ok = await fetch(runsUrl(base), { headers: { Cookie: cookie } });
  assert.equal(ok.status, 200);
  const { runs } = await ok.json();
  assert.equal(runs.length, 1);
  assert.equal((await fetch(`${base}/claude/runs/${runs[0].id}`)).status, 401, 'a known id still needs the login');
});

test('without a login the transcript views need a loopback Host, like /api', async (t) => {
  const cfg = await tempDir(t);
  const { app } = await tempServer(t, { claudeConfigDirs: [cfg] });
  const res = await rawRequest(app.port, [`GET /claude/runs?cwd=%2Fwork%2Fdemo&since=${T0} HTTP/1.1`, 'Host: attacker.example', 'Connection: close']);
  assert.match(res, /^HTTP\/1\.1 403/);
  const ok = await rawRequest(app.port, [`GET /claude/runs?cwd=%2Fwork%2Fdemo&since=${T0} HTTP/1.1`, `Host: 127.0.0.1:${app.port}`, 'Connection: close']);
  assert.match(ok, /^HTTP\/1\.1 200/);
  const cross = await rawRequest(app.port, [`GET /claude/runs?cwd=%2Fwork%2Fdemo&since=${T0} HTTP/1.1`, `Host: 127.0.0.1:${app.port}`, 'Origin: https://evil.example', 'Connection: close']);
  assert.match(cross, /^HTTP\/1\.1 403/);
});
