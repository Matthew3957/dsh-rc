// --tunnel shows the public URL as a QR code: in the terminal, and to a logged-in
// page through GET /tunnel. The fake cloudflared in fixtures stands in for the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.mjs';
import { savePassphrase } from '../server/auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PASSPHRASE = 'correct horse battery';
const quiet = { log() {}, error() {} };

async function start(t, options = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rc-qr-test-'));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  savePassphrase(stateDir, PASSPHRASE);
  const app = await startServer({ port: 0, host: '127.0.0.1', stateDir, sender: { send: async () => {} }, watch: false, logger: quiet, ...options });
  t.after(() => app.close());
  return `http://127.0.0.1:${app.port}`;
}

async function login(base) {
  const res = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'passphrase=' + encodeURIComponent(PASSPHRASE),
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  return res.headers.get('set-cookie').split(';')[0];
}

test('--tunnel logs a QR code and serves the URL at /tunnel to a session only', async (t) => {
  const saved = process.env.PATH;
  process.env.PATH = `${path.join(here, 'fixtures', 'cloudflared-ok')}:${saved}`;
  t.after(() => { process.env.PATH = saved; });
  const logged = [];
  const logger = { log: (line) => logged.push(line), error: (line) => logged.push(line) };
  const base = await start(t, { tunnel: true, logger });
  process.env.PATH = saved;

  const qr = logged.find((line) => line.includes('█'));
  assert.ok(qr, 'a QR code was logged');
  assert.ok(qr.split('\n').length > 10);

  assert.equal((await fetch(base + '/tunnel')).status, 401);
  const cookie = await login(base);
  const res = await fetch(base + '/tunnel', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: 'https://fake-test-tunnel.trycloudflare.com/' });
  const post = await fetch(base + '/tunnel', { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  assert.equal(post.status, 405);
});

test('/tunnel says null when there is no tunnel', async (t) => {
  const base = await start(t);
  const cookie = await login(base);
  const res = await fetch(base + '/tunnel', { headers: { Cookie: cookie } });
  assert.deepEqual(await res.json(), { url: null });
});
