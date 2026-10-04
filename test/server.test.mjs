import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startServer, validateSubscription, resolveStatic, appBasePath, MAX_SUBSCRIPTIONS } from '../server/index.mjs';

const quiet = { log() {}, error() {} };

// fetch() normalizes dot segments before the request leaves the client, so the
// traversal tests talk to the server over a raw socket to keep the path intact.
function rawRequest(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

function fakeSender(onSend) {
  return {
    send: async (subscription, payload) => {
      if (onSend) await onSend(subscription, payload);
    },
  };
}

async function tempServer(t, { sender = fakeSender(), options = {} } = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rc-test-'));
  const app = await startServer({ port: 0, host: '127.0.0.1', stateDir, sender, watch: false, logger: quiet, ...options });
  t.after(async () => {
    await app.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  });
  return { app, base: `http://127.0.0.1:${app.port}`, stateDir };
}

const httpsSub = (endpoint, extra = {}) => ({ endpoint, keys: { p256dh: 'p256dh-value', auth: 'auth-value' }, ...extra });
const postJson = (base, route, body) => fetch(base + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('binds loopback only', async (t) => {
  const { app } = await tempServer(t);
  assert.equal(app.host, '127.0.0.1');
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rc-test-'));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  await assert.rejects(
    () => startServer({ port: 0, host: '0.0.0.0', stateDir, sender: fakeSender(), watch: false, logger: quiet }),
    /loopback/,
  );
});

test('rejects path traversal and never serves outside public/', async (t) => {
  const { base, app } = await tempServer(t);
  for (const target of ['/%2e%2e/%2e%2e/etc/passwd', '/../../package.json', '/..%2fpackage.json', '/%2e%2e%2fserver%2findex.mjs']) {
    const response = await rawRequest(app.port, target);
    assert.match(response.split('\r\n')[0], / 403 /, target);
  }
  // package.json and server/ live outside public/, so they are plain 404s.
  assert.equal((await fetch(base + '/package.json')).status, 404);
  assert.equal((await fetch(base + '/server/index.mjs')).status, 404);
});

test('resolveStatic rejects escapes and accepts in-tree paths', () => {
  const root = path.resolve('/tmp/dsh-rc-public');
  assert.equal(resolveStatic(root, '/../secret'), null);
  assert.equal(resolveStatic(root, '/..%2fsecret'), null);
  assert.equal(resolveStatic(root, '/%2e%2e/secret'), null);
  assert.equal(resolveStatic(root, '/'), root);
  assert.equal(resolveStatic(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(resolveStatic(root, '/vendor/app.js'), path.join(root, 'vendor', 'app.js'));
});

test('serves correct content types', async (t) => {
  const { base } = await tempServer(t);
  const cases = [
    ['/', 'text/html'],
    ['/app.js', 'text/javascript'],
    ['/sw.js', 'text/javascript'],
    ['/style.css', 'text/css'],
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/icon.svg', 'image/svg+xml'],
    ['/icon-180.png', 'image/png'],
  ];
  for (const [route, type] of cases) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200, route);
    assert.ok(res.headers.get('content-type').startsWith(type), `${route}: ${res.headers.get('content-type')}`);
  }
});

test('app shell files are no-cache, assets are cacheable', async (t) => {
  const { base } = await tempServer(t);
  for (const route of ['/', '/app.js', '/sw.js', '/style.css']) {
    const res = await fetch(base + route);
    assert.equal(res.headers.get('cache-control'), 'no-cache', route);
  }
  assert.equal((await fetch(base + '/icon-180.png')).headers.get('cache-control'), 'public, max-age=300');
});

test('does not list directories', async (t) => {
  const { base } = await tempServer(t);
  for (const route of ['/vendor', '/vendor/']) {
    const res = await fetch(base + route);
    assert.equal(res.status, 404, route);
    assert.ok(!/index of/i.test(await res.text()), route);
  }
});

test('appBasePath finds the app root from the path or a same-origin Referer', () => {
  assert.equal(appBasePath('/research/notes.md'), '/');
  assert.equal(appBasePath('/m/research/notes.md'), '/m/');
  assert.equal(appBasePath('/m'), '/m/');
  // A proxy that strips /m forwards /research/notes.md; the Referer still names the mount.
  assert.equal(appBasePath('/research/notes.md', 'http://d.example/m/'), '/m/');
  assert.equal(appBasePath('/research/notes.md', 'http://d.example/m/index.html'), '/m/');
  assert.equal(appBasePath('/research/notes.md', 'http://d.example/'), '/');
  // A Referer from another host must not steer the back link.
  assert.equal(appBasePath('/research/notes.md', 'http://evil.example/', 'd.example'), '/');
});

test('a browser navigation to a missing page gets a styled 404 with a way back', async (t) => {
  const { base } = await tempServer(t);
  const accept = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

  const root = await fetch(base + '/research/notes.md', { headers: accept });
  assert.equal(root.status, 404);
  assert.match(root.headers.get('content-type'), /text\/html/);
  const rootHtml = await root.text();
  assert.match(rootHtml, /Back to dsh-rc/);
  assert.match(rootHtml, /href="\/"/);
  assert.match(rootHtml, /research\/notes\.md/);
  assert.match(rootHtml, /color-scheme: light dark/);

  const mounted = await fetch(base + '/m/research/notes.md', { headers: accept });
  assert.equal(mounted.status, 404);
  const mountedHtml = await mounted.text();
  assert.match(mountedHtml, /href="\/m\/"/);
  assert.ok(!mountedHtml.includes('href="/"'), 'under /m/ the way back stays under /m/');

  // The Referer names the mount even when the proxy strips it from the path.
  const stripped = await fetch(base + '/research/notes.md', { headers: { ...accept, Referer: base + '/m/' } });
  assert.equal(stripped.status, 404);
  assert.match(await stripped.text(), /href="\/m\/"/);
});

test('a missing asset is still a plain-text 404', async (t) => {
  const { base } = await tempServer(t);
  const res = await fetch(base + '/research/notes.md'); // no Accept: text/html
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.equal(await res.text(), 'Not found');
});

test('GET /push/key returns the VAPID public key', async (t) => {
  const { base } = await tempServer(t);
  const res = await fetch(base + '/push/key');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.key, 'string');
  assert.ok(body.key.length > 40);
  assert.match(body.key, /^[A-Za-z0-9_-]+$/);
});

test('validateSubscription: https only, keys required', () => {
  assert.equal(validateSubscription(httpsSub('https://fcm.googleapis.com/fcm/send/a')), null);
  assert.match(validateSubscription(httpsSub('http://push.example.com/a')), /https/);
  assert.match(validateSubscription({ endpoint: 'not a url', keys: { p256dh: 'a', auth: 'b' } }), /not a URL/);
  assert.match(validateSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/a' }), /keys/);
  assert.match(validateSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: 'a' } }), /p256dh/);
  assert.match(validateSubscription(null), /PushSubscription/);
});

test('POST /push/subscribe validates and replaces by endpoint', async (t) => {
  const { base, app } = await tempServer(t);
  assert.equal((await postJson(base, '/push/subscribe', httpsSub('http://push.example.com/a'))).status, 400);
  assert.equal((await postJson(base, '/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/a' })).status, 400);
  assert.equal((await postJson(base, '/push/subscribe', httpsSub('https://fcm.googleapis.com/fcm/send/a'))).status, 200);
  const again = await postJson(base, '/push/subscribe', httpsSub('https://fcm.googleapis.com/fcm/send/a'));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).count, 1);
  assert.equal(app.store.size(), 1);
  assert.equal((await postJson(base, '/push/subscribe', 'nope')).status, 400);
});

test('POST /push/subscribe rejects bodies over 16 KB', async (t) => {
  const { base } = await tempServer(t);
  const huge = httpsSub('https://fcm.googleapis.com/fcm/send/' + 'x'.repeat(17 * 1024));
  const res = await postJson(base, '/push/subscribe', huge);
  assert.equal(res.status, 413);
});

test('POST /push/subscribe caps the subscription count', async (t) => {
  const { base } = await tempServer(t);
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
    const res = await postJson(base, '/push/subscribe', httpsSub(`https://fcm.googleapis.com/fcm/send/${i}`));
    assert.equal(res.status, 200, String(i));
  }
  assert.equal((await postJson(base, '/push/subscribe', httpsSub('https://fcm.googleapis.com/fcm/send/over'))).status, 400);
  // Re-saving an endpoint that is already stored is still allowed.
  assert.equal((await postJson(base, '/push/subscribe', httpsSub('https://fcm.googleapis.com/fcm/send/0'))).status, 200);
});

test('POST /push/unsubscribe removes an endpoint', async (t) => {
  const { base, app } = await tempServer(t);
  await postJson(base, '/push/subscribe', httpsSub('https://fcm.googleapis.com/fcm/send/a'));
  const res = await postJson(base, '/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/a' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).removed, 1);
  assert.equal(app.store.size(), 0);
  assert.equal((await postJson(base, '/push/unsubscribe', {})).status, 400);
});

test('POST /push/test uses the injected sender and prunes 404/410', async (t) => {
  const sent = [];
  const sender = fakeSender(async (subscription, payload) => {
    sent.push({ subscription, payload });
    if (subscription.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
  });
  const { base, app } = await tempServer(t, { sender });
  await postJson(base, '/push/subscribe', httpsSub('https://fcm.googleapis.com/fcm/send/live'));
  await postJson(base, '/push/subscribe', httpsSub('https://fcm.googleapis.com/fcm/send/gone'));

  const res = await fetch(base + '/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent, 1);
  assert.equal(body.removed, 1);
  assert.equal(app.store.size(), 1);
  assert.equal(app.store.list()[0].endpoint, 'https://fcm.googleapis.com/fcm/send/live');

  const payload = JSON.parse(sent[0].payload);
  assert.equal(payload.title, 'dsh-rc');
  assert.equal(typeof payload.tag, 'string');
});

test('state lives in 0600 files inside a 0700 directory', async (t) => {
  const { base, stateDir } = await tempServer(t);
  assert.equal((await fsp.stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(path.join(stateDir, 'vapid.json'))).mode & 0o777, 0o600);
  await postJson(base, '/push/subscribe', httpsSub('https://fcm.googleapis.com/fcm/send/a'));
  assert.equal((await fsp.stat(path.join(stateDir, 'subscriptions.json'))).mode & 0o777, 0o600);
});

test('non-GET/HEAD on static paths is refused', async (t) => {
  const { base } = await tempServer(t);
  const res = await fetch(base + '/index.html', { method: 'POST', body: '' });
  assert.equal(res.status, 405);
});

test('unknown /push routes are 404', async (t) => {
  const { base } = await tempServer(t);
  assert.equal((await fetch(base + '/push/nope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
});

test('POST /push/* without a JSON content type is refused (no cross-site simple requests)', async (t) => {
  const { base } = await tempServer(t);
  for (const route of ['/push/test', '/push/subscribe', '/push/unsubscribe']) {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(res.status, 415, route);
  }
});

test('validateSubscription: only known push services', () => {
  const keys = { p256dh: 'a', auth: 'b' };
  for (const ok of ['https://web.push.apple.com/x', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-by3p.notify.windows.com/w/?token=x']) {
    assert.equal(validateSubscription({ endpoint: ok, keys }), null, ok);
  }
  for (const bad of ['https://example.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x', 'https://evilnotify.windows.com/x']) {
    assert.match(validateSubscription({ endpoint: bad, keys }), /known push service/, bad);
  }
});
