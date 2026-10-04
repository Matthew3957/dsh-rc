// Switching connectors from the phone (#70): the proxy rules, the payload checks, the server
// wiring against a stand-in dsh, and the page's helpers in dsh02.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.mjs';
import { savePassphrase } from '../server/auth.mjs';
import { isTailnetHostname, parseToggle, pluginChangeRefusal, toggleBody, toggleRefusal } from '../server/plugin-changes.mjs';
import { describeToggle, pluginKind, switchableEntries } from '../public/dsh02.js';

const quiet = { log() {}, error() {} };
const PASSPHRASE = 'correct horse battery';

// Rows shaped like dsh 0.2's `pluginManager/listPlugins` (dsh-plugin-manager's PluginInfo).
const LIST = [
  { entryId: 'include:mcp-docs', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'active', patchId: 'mcp-docs' },
  { entryId: 'include:mcp-locked', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable' },
  { entryId: 'include:subagent-claude-code', moduleName: '@deepseek-ai/dsh-subagent-claude-code', enabled: false, fiberPhase: null, patchId: 'subagent-claude-code' },
  { entryId: 'include:tool-subagent-claude-code', moduleName: '@deepseek-ai/dsh-subagent-claude-code/tool', enabled: true, fiberPhase: 'active', patchId: 'tool-subagent-claude-code' },
  { entryId: 'include:llm', moduleName: '@deepseek-ai/dsh-llm', enabled: true, fiberPhase: 'active', patchId: 'llm' },
  { entryId: 'include:mcp-resources', moduleName: '@deepseek-ai/dsh-mcp-resources', enabled: true, fiberPhase: 'active', patchId: 'mcp-resources' },
  { entryId: 'include:plugin-manager', moduleName: '@deepseek-ai/dsh-plugin-manager', enabled: true, fiberPhase: 'active', readOnlyReason: 'management-required' },
];

const toggleRequest = (id, enabled, extra = {}) =>
  JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'pluginManager/setPluginEnabled', payload: { args: { id, enabled } }, ...extra });

// ---------- pure rules ----------

test('pluginKind: MCP connectors and subagent providers, never core plugins or provider tool rows', () => {
  assert.equal(pluginKind(LIST[0]), 'connector');
  assert.equal(pluginKind(LIST[2]), 'subagent');
  assert.equal(pluginKind(LIST[3]), null, 'a provider tool row');
  assert.equal(pluginKind(LIST[4]), null, 'core');
  assert.equal(pluginKind(LIST[5]), null, 'mcp-resources is not a connector');
  assert.equal(pluginKind(LIST[6]), null);
  assert.equal(pluginKind({ entryId: 'x', moduleName: '@deepseek-ai/dsh-mcp-client-extra' }), null);
  assert.equal(pluginKind(null), null);
});

test('switchableEntries: only connector and provider rows dsh lists with a patch target', () => {
  const m = switchableEntries(LIST);
  assert.equal(m.get('include:mcp-docs'), true);
  assert.equal(m.get('include:subagent-claude-code'), true);
  assert.equal(m.get('include:mcp-locked'), false, 'read-only in dsh');
  assert.equal(m.get('include:llm'), false);
  assert.equal(m.get('include:tool-subagent-claude-code'), false);
  assert.equal(switchableEntries(null).size, 0);
});

test('describeToggle: one honest line per ChangeResult outcome', () => {
  assert.deepEqual(describeToggle({ changed: true, application: 'applied', stage: 'enable', target: 'x' }, 'docs', false), { ok: true, text: 'Switched docs off' });
  assert.deepEqual(describeToggle({ changed: false, application: 'applied' }, 'docs', true), { ok: true, text: 'docs was already on' });
  assert.match(describeToggle({ changed: true, application: 'restart-required' }, 'docs', true).text, /restarts/);
  assert.equal(describeToggle({ changed: true, application: 'overridden' }, 'docs', true).ok, false);
  assert.deepEqual(describeToggle({ changed: false, application: 'failed', error: { code: 'unknown-plugin' } }, 'docs', true), { ok: false, text: 'Could not switch docs on (unknown-plugin)' });
});

test('pluginChangeRefusal: login on, or a loopback or Tailscale Host without one', () => {
  const req = (host) => ({ headers: { host } });
  assert.equal(pluginChangeRefusal(req('box.lan'), { authEnabled: true }), null);
  assert.equal(pluginChangeRefusal(req('127.0.0.1:3081'), { authEnabled: false }), null);
  assert.equal(pluginChangeRefusal(req('localhost'), { authEnabled: false }), null);
  assert.equal(pluginChangeRefusal(req('machine.tailnet-name.ts.net'), { authEnabled: false }), null);
  assert.match(pluginChangeRefusal(req('box.private.example'), { authEnabled: false }), /login/);
  assert.match(pluginChangeRefusal(req('evil-ts.net.example'), { authEnabled: false }), /login/);
  assert.ok(pluginChangeRefusal({ headers: {} }, { authEnabled: false }));
  assert.equal(isTailnetHostname('ts.net'), false);
});

test('parseToggle accepts only the exact page request', () => {
  assert.deepEqual(parseToggle(toggleRequest('include:mcp-docs', false)), { rpcId: 'r1', id: 'include:mcp-docs', enabled: false });
  const bad = [
    'not json',
    JSON.stringify([]),
    toggleRequest('include:mcp-docs', 'false'),
    toggleRequest('', true),
    toggleRequest('include:mcp-docs', true, { method: 'pluginManager/installBundle' }),
    toggleRequest('include:mcp-docs', true, { type: 'client-response' }),
    toggleRequest('include:mcp-docs', true, { extra: 1 }),
    toggleRequest('include:mcp-docs', true, { rpcId: { x: 1 } }),
    // A connector config smuggled beside the switch: no command, args, env or url ever pass.
    JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'pluginManager/setPluginEnabled', payload: { args: { id: 'include:mcp-docs', enabled: true, command: 'sh' } } }),
    JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'pluginManager/setPluginEnabled', payload: { args: { id: 'include:mcp-docs', enabled: true }, config: { transport: 'stdio' } } }),
    JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'pluginManager/setPluginEnabled', payload: { args: { id: 'x' } } }),
  ];
  for (const raw of bad) assert.ok(parseToggle(raw).error, raw);
});

test('toggleRefusal: the entry must exist, be a connector or provider, and be addressable', () => {
  assert.equal(toggleRefusal(LIST, 'include:mcp-docs'), null);
  assert.equal(toggleRefusal(LIST, 'include:subagent-claude-code'), null);
  assert.match(toggleRefusal(LIST, 'include:nope'), /no such plugin/);
  assert.match(toggleRefusal(LIST, 'include:llm'), /only MCP connectors/);
  assert.match(toggleRefusal(LIST, 'include:mcp-locked'), /read-only/);
  assert.match(toggleRefusal(null, 'include:mcp-docs'), /no such plugin/);
});

test('toggleBody rebuilds the request from the checked fields only', () => {
  assert.deepEqual(JSON.parse(toggleBody({ rpcId: 7, id: 'include:mcp-docs', enabled: true })),
    { type: 'client-request', rpcId: 7, method: 'pluginManager/setPluginEnabled', payload: { args: { id: 'include:mcp-docs', enabled: true } } });
});

// ---------- the running server against a stand-in dsh ----------

/** Stand-in dsh 0.2: answers listPlugins from LIST and records every request it sees. */
async function fakeDsh() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url, host: req.headers.host, body });
      const value = req.url === '/api/pluginManager/listPlugins' ? LIST : { changed: true, application: 'applied', stage: 'enable', target: 'x' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function tempServer(t, options = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rc-plugins-test-'));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  if (options.passphrase) savePassphrase(stateDir, PASSPHRASE);
  const app = await startServer({ port: 0, host: '127.0.0.1', stateDir, sender: { send: async () => {} }, watch: false, logger: quiet, ...options });
  t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${app.port}` };
}

/** Raw HTTP/1.1 request, so Host can be anything. */
function rawRequest(port, { method = 'GET', pathname, host, body = '', headers = [] }) {
  return new Promise((resolve, reject) => {
    const lines = [`${method} ${pathname} HTTP/1.1`, `Host: ${host}`, 'Connection: close', 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, ...headers];
    const socket = net.connect(port, '127.0.0.1', () => socket.write(lines.join('\r\n') + '\r\n\r\n' + body));
    let data = '';
    socket.on('data', (c) => { data += c.toString('utf8'); });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
}

const post = (base, method, body) => fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

test('a switch for a connector goes through, rebuilt, after the proxy reads the list itself', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { base } = await tempServer(t, { dshUrl: dsh.url });

  const res = await post(base, 'pluginManager/setPluginEnabled', toggleRequest('include:mcp-docs', false));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.value.application, 'applied');
  assert.deepEqual(dsh.seen.map((s) => s.url), ['/api/pluginManager/listPlugins', '/api/pluginManager/setPluginEnabled']);
  assert.ok(dsh.seen.every((s) => s.host === 'dsh-rc.internal'));
  assert.deepEqual(JSON.parse(dsh.seen[1].body).payload, { args: { id: 'include:mcp-docs', enabled: false } });

  const list = await post(base, 'pluginManager/listPlugins', JSON.stringify({ type: 'client-request', rpcId: 'l', method: 'pluginManager/listPlugins', payload: { args: {} } }));
  assert.equal(list.status, 200);
});

test('a switch for a core plugin, a read-only row, an unknown id or a bad payload never reaches dsh', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { base } = await tempServer(t, { dshUrl: dsh.url });

  for (const [body, status, reason] of [
    [toggleRequest('include:llm', false), 403, /only MCP connectors/],
    [toggleRequest('include:mcp-locked', false), 403, /read-only/],
    [toggleRequest('include:nope', true), 403, /no such plugin/],
    [toggleRequest('include:mcp-docs', true, { method: 'pluginManager/removeBundle' }), 400, /client request/],
    ['{"type":"client-request","rpcId":"r","method":"pluginManager/setPluginEnabled","payload":{"args":{"id":"include:mcp-docs","enabled":true,"env":{}}}}', 400, /exactly/],
  ]) {
    const res = await post(base, 'pluginManager/setPluginEnabled', body);
    assert.equal(res.status, status, body);
    assert.match(res.headers.get('x-dsh-rc-refused'), reason);
  }
  assert.ok(dsh.seen.every((s) => s.url === '/api/pluginManager/listPlugins'), 'only the proxy\'s own reads');
});

test('the rest of pluginManager stays refused, adds and installs included', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { base } = await tempServer(t, { dshUrl: dsh.url });
  for (const method of ['pluginManager/installBundle', 'pluginManager/removeBundle', 'pluginManager/setBundleEnabled', 'pluginManager/inspect', 'pluginManager/setVersionExemption', 'settings/update', 'settings/mutate']) {
    const res = await post(base, method, '{}');
    assert.equal(res.status, 403, method);
  }
  assert.deepEqual(dsh.seen, []);
});

test('without a login, a trusted LAN name may read dsh but not switch plugins; loopback may', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { app } = await tempServer(t, { dshUrl: dsh.url, trustedHosts: ['box.private.example', 'machine.tailnet-name.ts.net'] });

  const lan = await rawRequest(app.port, { method: 'POST', pathname: '/api/pluginManager/setPluginEnabled', host: 'box.private.example', body: toggleRequest('include:mcp-docs', false) });
  assert.match(lan, /^HTTP\/1\.1 403/);
  assert.match(lan, /x-dsh-rc-refused: .*login/i);
  const lanList = await rawRequest(app.port, { method: 'POST', pathname: '/api/pluginManager/listPlugins', host: 'box.private.example', body: '{}' });
  assert.match(lanList, /^HTTP\/1\.1 403/);
  const cap = await rawRequest(app.port, { pathname: '/plugin-changes', host: 'box.private.example' });
  assert.match(cap, /"toggle":false/);
  assert.deepEqual(dsh.seen, []);

  const tailnet = await rawRequest(app.port, { method: 'POST', pathname: '/api/pluginManager/setPluginEnabled', host: 'machine.tailnet-name.ts.net', body: toggleRequest('include:mcp-docs', false) });
  assert.match(tailnet, /^HTTP\/1\.1 200/);
  const local = await rawRequest(app.port, { pathname: '/plugin-changes', host: '127.0.0.1' });
  assert.match(local, /"toggle":true/);
});

test('with a login, switching needs the session and then works from any Host', async (t) => {
  const dsh = await fakeDsh();
  t.after(() => dsh.server.close());
  const { app, base } = await tempServer(t, { dshUrl: dsh.url, passphrase: true });

  assert.equal((await post(base, 'pluginManager/setPluginEnabled', toggleRequest('include:mcp-docs', false))).status, 401);
  assert.equal((await fetch(base + '/plugin-changes')).status, 401);
  const login = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'passphrase=' + encodeURIComponent(PASSPHRASE), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await rawRequest(app.port, { method: 'POST', pathname: '/api/pluginManager/setPluginEnabled', host: 'box.lan', body: toggleRequest('include:mcp-docs', true), headers: [`Cookie: ${cookie}`] });
  assert.match(res, /^HTTP\/1\.1 200/);
  const cap = await fetch(base + '/plugin-changes', { headers: { Cookie: cookie } });
  assert.deepEqual(await cap.json(), { toggle: true });
});
