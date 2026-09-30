import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

import { createProxy, checkRequest, apiMethodOf, isPrivilegedMethod, DEFAULT_UPSTREAM_HOST } from '../server/proxy.mjs';

const quiet = { log() {}, error() {} };

/** A tiny stand-in for dsh: echoes back the Host/Origin/method/body it saw. */
async function fakeDsh() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin || null, cookie: req.headers.cookie || null, method: req.method, body }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function proxyServer(dshUrl) {
  const proxy = createProxy({ dshUrl, logger: quiet });
  const server = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, proxy };
}

test('proxy presents the dedicated non-loopback Host and Origin to dsh', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.close());
  const dshUrl = `http://127.0.0.1:${dsh.address().port}`;
  const { server } = await proxyServer(dshUrl);
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ping`, {
    method: 'POST',
    headers: { Host: 'not-the-real-host.example', Origin: 'https://not-the-real-host.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.host, DEFAULT_UPSTREAM_HOST);
  assert.equal(body.origin, `http://${DEFAULT_UPSTREAM_HOST}`);
  assert.equal(body.method, 'POST');
  assert.deepEqual(JSON.parse(body.body), { hello: 'world' });
});

test('proxy never takes the upstream from the request, even a crafted Host', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.close());
  const evil = await fakeDsh(); // a second server that must never be reached
  t.after(() => evil.close());
  const dshUrl = `http://127.0.0.1:${dsh.address().port}`;
  const { server } = await proxyServer(dshUrl);
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ping`, {
    headers: { Host: `127.0.0.1:${evil.address().port}` },
  });
  const body = await res.json();
  assert.equal(body.host, DEFAULT_UPSTREAM_HOST, 'reached the configured dsh, not the one named in Host');
});

test('proxy never forwards the dsh-rc session cookie', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.close());
  const { server } = await proxyServer(`http://127.0.0.1:${dsh.address().port}`);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/ping`;
  let body = await (await fetch(base, { headers: { cookie: 'dsh_rc_session=secret.token; other=1' } })).json();
  assert.equal(body.cookie, 'other=1');
  body = await (await fetch(base, { headers: { cookie: 'dsh_rc_session=secret.token' } })).json();
  assert.equal(body.cookie, null);
});

test('createProxy refuses a loopback upstream Host', () => {
  for (const upstreamHost of ['127.0.0.1', 'localhost:3080', '[::1]', '127.1.2.3']) {
    assert.throws(() => createProxy({ dshUrl: 'http://127.0.0.1:3080', upstreamHost, logger: quiet }), /loopback/, upstreamHost);
  }
  assert.throws(() => createProxy({ dshUrl: 'http://127.0.0.1:3080', upstreamHost: 'a/b', logger: quiet }), /host/);
});

const req = (headers) => ({ headers });

test('checkRequest: an Origin must match the Host it was sent to', () => {
  assert.equal(checkRequest(req({ host: '127.0.0.1:3081' })), null, 'no Origin (curl, same-origin GET) passes');
  assert.equal(checkRequest(req({ host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' })), null);
  assert.equal(checkRequest(req({ host: 'x.trycloudflare.com', origin: 'https://x.trycloudflare.com' })), null, 'scheme may differ behind a tunnel');
  assert.match(checkRequest(req({ host: '127.0.0.1:3081', origin: 'https://evil.example' })), /cross-origin/);
  assert.match(checkRequest(req({ host: 'localhost:3081', origin: 'http://localhost:5173' })), /cross-origin/, 'another local port is another origin');
  assert.match(checkRequest(req({ host: '127.0.0.1:3081', origin: 'null' })), /cross-origin/);
  assert.match(checkRequest(req({ host: '127.0.0.1:3081', 'sec-fetch-site': 'cross-site' })), /cross-site/);
  assert.match(checkRequest(req({})), /Host/);
});

test('checkRequest: without a login, Host must be loopback or trusted', () => {
  const fence = { requireLoopbackHost: true, trustedHosts: ['box.private.example', 'lan.example:8443'] };
  for (const host of ['127.0.0.1:3081', 'localhost:3081', '[::1]:3081']) assert.equal(checkRequest(req({ host }), fence), null, host);
  assert.match(checkRequest(req({ host: 'rebound.example:3081' }), fence), /not loopback/);
  assert.equal(checkRequest(req({ host: 'box.private.example' }), fence), null, 'bare trusted name, any port');
  assert.equal(checkRequest(req({ host: 'box.private.example:3081' }), fence), null);
  assert.equal(checkRequest(req({ host: 'lan.example:8443' }), fence), null);
  assert.match(checkRequest(req({ host: 'lan.example:9999' }), fence), /not loopback/, 'host:port entries are exact');
  assert.equal(checkRequest(req({ host: 'rebound.example:3081' }), { requireLoopbackHost: false }), null, 'with a login any Host passes');
});

test('apiMethodOf refuses dot segments and encoded separators; privileged methods are named', () => {
  assert.equal(apiMethodOf('/api/session.list'), 'session.list');
  assert.equal(apiMethodOf('/api/commands/execute'), 'commands/execute');
  assert.equal(apiMethodOf('/api/../push/test'), null);
  assert.equal(apiMethodOf('/api/x/./y'), null);
  assert.equal(apiMethodOf('/api/settings%2Eupdate'), null);
  assert.equal(apiMethodOf('/other'), null);
  for (const m of ['settings.update', 'settings/describe', 'credentials.set', 'host.openPath', 'host.pickDirectory', 'agentPreset.read', 'agentPreset.remove', 'SETTINGS.update']) {
    assert.equal(isPrivilegedMethod(m), true, m);
  }
  for (const m of ['session.list', 'session.prompt', 'host.describe', 'host.listDirectory', 'agentPreset.list', 'agentPreset.select', 'respond', 'events.mux']) {
    assert.equal(isPrivilegedMethod(m), false, m);
  }
});

test('proxy streams a large request body without buffering it whole', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.close());
  const dshUrl = `http://127.0.0.1:${dsh.address().port}`;
  const { server } = await proxyServer(dshUrl);
  t.after(() => server.close());

  const big = 'x'.repeat(1024 * 512);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: big,
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.body.length, big.length);
});

test('proxy relays a non-2xx upstream response (e.g. dsh 403) verbatim', async (t) => {
  const dsh = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('trusted-host mismatch');
  });
  await new Promise((resolve) => dsh.listen(0, '127.0.0.1', resolve));
  t.after(() => dsh.close());
  const dshUrl = `http://127.0.0.1:${dsh.address().port}`;
  const { server } = await proxyServer(dshUrl);
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/whoami`);
  assert.equal(res.status, 403);
  assert.equal(await res.text(), 'trusted-host mismatch');
});

test('proxy answers 502 when upstream is unreachable', async (t) => {
  const { server } = await proxyServer('http://127.0.0.1:1'); // nothing listens on port 1
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ping`);
  assert.equal(res.status, 502);
});

test('proxyUpgrade relays a WebSocket handshake and frames both ways with the presented Host', async (t) => {
  const dsh = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  dsh.on('upgrade', (req, socket) => {
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        `X-Seen-Host: ${req.headers.host}\r\n` +
        `X-Seen-Origin: ${req.headers.origin}\r\n\r\n`,
    );
    // Echo whatever the client sends after the handshake, then close.
    socket.once('data', (chunk) => socket.end(Buffer.concat([Buffer.from('echo:'), chunk])));
  });
  await new Promise((resolve) => dsh.listen(0, '127.0.0.1', resolve));
  t.after(() => dsh.close());
  const dshUrl = `http://127.0.0.1:${dsh.address().port}`;
  const proxy = createProxy({ dshUrl, logger: quiet });
  const front = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  front.on('upgrade', (req, socket, head) => proxy.proxyUpgrade(req, socket, head));
  await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
  t.after(() => front.close());

  const seen = await new Promise((resolve, reject) => {
    const socket = net.connect(front.address().port, '127.0.0.1', () => {
      socket.write(
        'GET /api/events.mux HTTP/1.1\r\n' +
          'Host: browser-supplied-host.example\r\n' +
          'Origin: http://browser-supplied-host.example\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let data = '';
    let sent = false;
    socket.on('data', (c) => {
      data += c.toString('utf8');
      if (!sent && data.includes('\r\n\r\n')) {
        sent = true;
        socket.write('ping');
      }
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); resolve(data); }, 2000);
  });
  assert.match(seen, /101 Switching Protocols/);
  assert.match(seen, new RegExp(`x-seen-host: ${DEFAULT_UPSTREAM_HOST.replace('.', '\\.')}`, 'i'));
  assert.match(seen, new RegExp(`x-seen-origin: http://${DEFAULT_UPSTREAM_HOST.replace('.', '\\.')}`, 'i'));
  assert.doesNotMatch(seen, /browser-supplied-host\.example/);
  assert.match(seen, /echo:ping$/, 'frames flow both ways after the handshake');
});
