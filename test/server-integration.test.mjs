// Integration coverage for the proxy + auth wiring inside startServer.
// Unit coverage for the pieces themselves lives in proxy.test.mjs and auth.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startServer, parseCliArgs } from '../server/index.mjs';
import { savePassphrase } from '../server/auth.mjs';
import { DEFAULT_UPSTREAM_HOST } from '../server/proxy.mjs';

const quiet = { log() {}, error() {} };
const PASSPHRASE = 'correct horse battery';

/** Stand-in for dsh: echoes the request, and accepts WebSocket upgrades. */
async function fakeDsh() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rc-int-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function tempServer(t, options = {}) {
  const stateDir = options.stateDir || (await tempDir(t));
  const app = await startServer({ port: 0, host: '127.0.0.1', stateDir, sender: { send: async () => {} }, watch: false, logger: quiet, ...options });
  t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${app.port}`, stateDir };
}

async function withPassphrase(t) {
  const stateDir = await tempDir(t);
  savePassphrase(stateDir, PASSPHRASE);
  return stateDir;
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

/** Raw HTTP/1.1 request, so Host can be anything. Resolves with the status line and body. */
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

function upgradeLines(pathname, host, extra = []) {
  return [
    `GET ${pathname} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...extra,
  ];
}

test('the running server proxies /api/* to dshUrl with the dedicated Host', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { base } = await tempServer(t, { dshUrl: dsh.url });

  const res = await fetch(base + '/api/commands/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ a: 1 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.host, DEFAULT_UPSTREAM_HOST);
  assert.equal(body.url, '/api/commands/execute');
  assert.deepEqual(JSON.parse(body.body), { a: 1 });
});

test('settings and credentials methods are never proxied', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { base } = await tempServer(t, { dshUrl: dsh.url });
  for (const method of ['settings.update', 'credentials.set', 'host.openPath']) {
    const res = await fetch(base + '/api/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403, method);
  }
  assert.equal((await fetch(base + '/api/..%2Fpush')).status, 400);
  assert.deepEqual(dsh.seen, []);
});

test('cross-origin writes are refused before they reach dsh or the push API', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { base } = await tempServer(t, { dshUrl: dsh.url });
  const evil = { Origin: 'https://evil.example', 'Content-Type': 'text/plain' };
  assert.equal((await fetch(base + '/api/session.prompt', { method: 'POST', headers: evil, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/push/test', { method: 'POST', headers: { ...evil, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const same = await fetch(base + '/api/session.list', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(same.status, 200);
  assert.deepEqual(dsh.seen, ['/api/session.list']);
});

test('without a login, /api needs a loopback or trusted Host (DNS rebinding, stray reverse proxies)', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { app } = await tempServer(t, { dshUrl: dsh.url, trustedHosts: ['box.private.example'] });

  const rebound = await rawRequest(app.port, ['GET /api/session.list HTTP/1.1', 'Host: rebound.example:3081', 'Connection: close']);
  assert.match(rebound, /^HTTP\/1\.1 403/);
  const trusted = await rawRequest(app.port, ['GET /api/session.list HTTP/1.1', 'Host: box.private.example', 'Connection: close']);
  assert.match(trusted, /^HTTP\/1\.1 200/);
  const ws = await rawRequest(app.port, upgradeLines('/api/events.mux', 'rebound.example:3081'));
  assert.match(ws, /^HTTP\/1\.1 403/);
  // The page itself is still served for any Host, as before (Tailscale Serve at /m).
  const page = await rawRequest(app.port, ['GET / HTTP/1.1', 'Host: rebound.example:3081', 'Connection: close']);
  assert.match(page, /^HTTP\/1\.1 200/);
  assert.deepEqual(dsh.seen, ['/api/session.list']);
});

test('with no passphrase configured, loopback behaves as before (no login)', async (t) => {
  const { base } = await tempServer(t);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/push/key')).status, 200);
  assert.equal((await fetch(base + '/login', { redirect: 'manual' })).status, 303, '/login just sends you to the page');
});

test('with a passphrase configured, everything but login and app-install files requires a session', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { base } = await tempServer(t, { stateDir: await withPassphrase(t), dshUrl: dsh.url });

  assert.equal((await fetch(base + '/login')).status, 200);
  const redirect = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get('location'), 'login', 'relative, so a /m mount still works');
  assert.equal((await fetch(base + '/app.js')).status, 401);
  assert.equal((await fetch(base + '/push/key')).status, 401);
  assert.equal((await fetch(base + '/api/session.list', { method: 'POST' })).status, 401);
  for (const file of ['/manifest.webmanifest', '/icon-180.png', '/icon.svg']) assert.equal((await fetch(base + file)).status, 200, file);
  assert.deepEqual(dsh.seen, []);

  const wrong = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'passphrase=nope' });
  assert.equal(wrong.status, 401);

  const cookie = await login(base);
  assert.equal((await fetch(base + '/push/key', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/app.js', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/api/session.list', { method: 'POST', headers: { cookie } })).status, 200);

  const out = await fetch(base + '/logout', { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('with a login, the event sockets need the session cookie but any Host', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { app, base } = await tempServer(t, { stateDir: await withPassphrase(t), dshUrl: dsh.url });
  const host = 'x.trycloudflare.com';
  assert.match(await rawRequest(app.port, upgradeLines('/api/events.mux', host)), /^HTTP\/1\.1 401/);
  const cookie = await login(base);
  const ok = await rawRequest(app.port, upgradeLines('/api/events.mux', host, [`Cookie: ${cookie}`, `Origin: https://${host}`]));
  assert.match(ok, /^HTTP\/1\.1 101/);
  const crossSite = await rawRequest(app.port, upgradeLines('/api/events.mux', host, [`Cookie: ${cookie}`, 'Origin: https://evil.example']));
  assert.match(crossSite, /^HTTP\/1\.1 403/);
  assert.match(await rawRequest(app.port, upgradeLines('/api/other', host, [`Cookie: ${cookie}`])), /^HTTP\/1\.1 404/);
});

test('refuses to bind a non-loopback host without a passphrase', async (t) => {
  const stateDir = await tempDir(t);
  for (const host of ['0.0.0.0', '::']) {
    await assert.rejects(
      () => startServer({ port: 0, host, stateDir, sender: { send: async () => {} }, watch: false, logger: quiet }),
      /loopback/,
      host,
    );
  }
});

test('allows a non-loopback host once a passphrase is configured', async (t) => {
  const { app } = await tempServer(t, { stateDir: await withPassphrase(t), host: '0.0.0.0' });
  assert.equal(app.auth.enabled, true);
  assert.equal(app.host, '0.0.0.0');
});

test('refuses to enable the tunnel without a passphrase, even on loopback', async (t) => {
  const stateDir = await tempDir(t);
  await assert.rejects(
    () => startServer({ port: 0, host: '127.0.0.1', stateDir, sender: { send: async () => {} }, watch: false, logger: quiet, tunnel: true }),
    /tunnel/,
  );
  await assert.rejects(
    () => startServer({ port: 0, stateDir, env: { DSH_RC_TUNNEL: '1' }, sender: { send: async () => {} }, watch: false, logger: quiet }),
    /tunnel/,
  );
});

test('a tunnel that fails to start does not leave the server listening', async (t) => {
  const stateDir = await withPassphrase(t);
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent';
  t.after(() => { process.env.PATH = saved; });
  await assert.rejects(
    () => startServer({ port, host: '127.0.0.1', stateDir, sender: { send: async () => {} }, watch: false, logger: quiet, tunnel: true }),
    /cloudflared not found/,
  );
  process.env.PATH = saved;
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`), 'the port is closed again');
});

test('https needs both a certificate and a key', async (t) => {
  const stateDir = await tempDir(t);
  await assert.rejects(
    () => startServer({ port: 0, stateDir, certFile: 'cert.pem', sender: { send: async () => {} }, watch: false, logger: quiet }),
    /both a certificate and a key/,
  );
});

test('parseCliArgs maps flags and refuses unknown or valueless ones', () => {
  assert.deepEqual(parseCliArgs(['--host', '0.0.0.0', '--port', '4000', '--tunnel', '--trusted-host', 'a.example', '--trusted-host', 'b.example']), {
    host: '0.0.0.0', port: 4000, tunnel: true, trustedHosts: ['a.example', 'b.example'],
  });
  assert.throws(() => parseCliArgs(['--hots', 'x']), /unknown option/);
  assert.throws(() => parseCliArgs(['--host']), /needs a value/);
  assert.throws(() => parseCliArgs(['--port', 'abc']), /bad --port/);
});
