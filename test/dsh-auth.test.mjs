import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDshAuth, parseSetCookies, tokenFrom } from '../server/dsh-auth.mjs';
import { createProxy, isPrivilegedMethod } from '../server/proxy.mjs';

const quiet = { log() {}, error() {} };

test('parseSetCookies keeps name=value pairs and the earliest Max-Age', () => {
  const { cookie, expires } = parseSetCookies(['a=1; Max-Age=100; Path=/; HttpOnly', 'b=2; Max-Age=50'], 1000);
  assert.equal(cookie, 'a=1; b=2');
  assert.equal(expires, 1000 + 50 * 1000);
  assert.deepEqual(parseSetCookies([], 0), { cookie: '', expires: null });
});

test('tokenFrom takes a bare token or the URL dsh printed', () => {
  assert.equal(tokenFrom('  abc  '), 'abc');
  assert.equal(tokenFrom('http://127.0.0.1:3080/?token=xyz'), 'xyz');
  assert.equal(tokenFrom('http://127.0.0.1:3080/'), null);
  assert.equal(tokenFrom(''), null);
});

test('cookieFor exchanges once per authority, caches, and re-exchanges after invalidate', async () => {
  const calls = [];
  const auth = createDshAuth({
    dshUrl: 'http://127.0.0.1:1',
    token: 'tok',
    logger: quiet,
    exchange: async (url, host, token) => {
      calls.push([host, token]);
      return { status: 303, setCookie: [`dsh-auth-${host}=v; Max-Age=2592000; HttpOnly`] };
    },
  });
  assert.equal(auth.enabled, true);
  assert.equal(await auth.cookieFor('one.example'), 'dsh-auth-one.example=v');
  assert.equal(await auth.cookieFor('one.example'), 'dsh-auth-one.example=v');
  assert.equal(await auth.cookieFor('two.example'), 'dsh-auth-two.example=v');
  assert.equal(calls.length, 2);
  auth.invalidate('one.example');
  await auth.cookieFor('one.example');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['one.example', 'tok']);
});

test('concurrent callers share one exchange', async () => {
  let n = 0;
  const auth = createDshAuth({ dshUrl: 'http://127.0.0.1:1', token: 't', logger: quiet, exchange: async () => { n += 1; return { status: 303, setCookie: ['c=1'] }; } });
  await Promise.all([auth.cookieFor('h'), auth.cookieFor('h'), auth.cookieFor('h')]);
  assert.equal(n, 1);
});

test('a refused token yields no cookie and is not retried in a tight loop', async () => {
  let n = 0;
  const errors = [];
  const auth = createDshAuth({ dshUrl: 'http://127.0.0.1:1', token: 'bad', logger: { log() {}, error: (m) => errors.push(m) }, exchange: async () => { n += 1; return { status: 401, setCookie: [] }; } });
  assert.equal(await auth.cookieFor('h'), null);
  assert.equal(await auth.cookieFor('h'), null);
  assert.equal(n, 1);
  assert.match(errors[0], /refused the launch token/);
});

test('without a token nothing is exchanged', async () => {
  const auth = createDshAuth({ dshUrl: 'http://127.0.0.1:1', logger: quiet, exchange: async () => { throw new Error('no'); } });
  assert.equal(auth.enabled, false);
  assert.equal(await auth.cookieFor('h'), null);
});

test('a token file is read on every exchange', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rc-tok-'));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, 'first\n');
  const seen = [];
  const auth = createDshAuth({ dshUrl: 'http://127.0.0.1:1', tokenFile: file, logger: quiet, exchange: async (u, h, t) => { seen.push(t); return { status: 303, setCookie: ['c=1'] }; } });
  await auth.cookieFor('h');
  fs.writeFileSync(file, 'second\n');
  auth.invalidate('h');
  await auth.cookieFor('h');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(seen, ['first', 'second']);
});

test('the real exchange sends the presented Host and reads the cookie', async (t) => {
  const seen = [];
  const dsh = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    res.writeHead(303, { Location: './', 'Set-Cookie': 'dsh-auth-x=signed; Max-Age=60; Path=/; HttpOnly' });
    res.end();
  });
  await new Promise((r) => dsh.listen(0, '127.0.0.1', r));
  t.after(() => dsh.close());
  const auth = createDshAuth({ dshUrl: `http://127.0.0.1:${dsh.address().port}`, token: 'a b', logger: quiet });
  assert.equal(await auth.cookieFor('dsh-rc.internal'), 'dsh-auth-x=signed');
  assert.deepEqual(seen, [{ host: 'dsh-rc.internal', url: '/?token=a%20b' }]);
});

test('the proxy replaces the browser cookie with the one dsh issued', async (t) => {
  const dsh = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cookie: req.headers.cookie || null }));
  });
  await new Promise((r) => dsh.listen(0, '127.0.0.1', r));
  t.after(() => dsh.close());
  const dshAuth = createDshAuth({ dshUrl: 'x', token: 't', logger: quiet, exchange: async () => ({ status: 303, setCookie: ['dsh-auth-k=signed'] }) });
  const proxy = createProxy({ dshUrl: `http://127.0.0.1:${dsh.address().port}`, logger: quiet, dshAuth });
  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  t.after(() => front.close());
  const res = await fetch(`http://127.0.0.1:${front.address().port}/api/session/list`, { method: 'POST', headers: { cookie: 'dsh-rc-session=secret; other=1' }, body: '{}' });
  assert.deepEqual(await res.json(), { cookie: 'dsh-auth-k=signed' });
});

test('dsh 0.2 methods that change settings or reach the desktop stay behind the proxy', () => {
  for (const m of ['settings/mutate', 'credentials/set', 'directoryPicker/pick', 'agentPresets/read', 'session/openWorkspacePath', 'pluginManager/installBundle', 'terminal/create', 'dynamicCordisRunner/invoke']) {
    assert.equal(isPrivilegedMethod(m), true, m);
  }
  for (const m of ['session/list', 'session/prompt', 'session/follow', 'workspace/archiveSession', 'directoryPicker/list', 'agentPresets/list', 'commands/execute', '$events/result', 'userQuestions/answer', 'pluginInventory/list']) {
    assert.equal(isPrivilegedMethod(m), false, m);
  }
});
