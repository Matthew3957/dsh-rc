// The smoke script's pure parts: method extraction from the page source and the
// read-only probe plan. The live RPC calls are exercised by running the script against
// a dsh; these tests keep a broken extractor or a widened probe list from passing CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  APP_PATH, NEWER_CALL_PROBES, NEWER_STREAM_PROBES, PROBES, callNewer, callRpc,
  exchangeLaunchToken, extractMethods, namespaceOf, planChecks, planNewerChecks, probeStream,
} from '../scripts/smoke.mjs';

// Methods the smoke must never send: they start, prompt, steer or change a session.
const CHANGES_A_SESSION = [
  'commands/execute', 'session.prompt', 'session.cancel', 'session.create',
  'session.rename', 'session.selectModel', 'session.updateQueue',
];

test('extractMethods finds rpc and remote method literals, deduped', () => {
  const source = `
    async function rpc(method, payload = {}, rpcId = rid()) { return method; }
    const remote = (method, args) => rpc(method, { args });
    rpc('session.list', {});
    remote("commands/execute", {});
    rpc(\`session.history\`, {});
    await rpc('session.list', {}); // duplicate
  `;
  assert.deepEqual(extractMethods(source), ['commands/execute', 'session.history', 'session.list']);
});

test('extractMethods ignores the rpc definition and non-method strings', () => {
  const source = `
    async function rpc(method, payload = {}, rpcId = rid()) {}
    const respond = (rpcId, result) => fetch('/api/respond', {});
    fetch('http://127.0.0.1:3080/api/x');
  `;
  assert.deepEqual(extractMethods(source), []);
});

test('namespaceOf splits the core dot form and the Typert slash form', () => {
  assert.equal(namespaceOf('session.list'), 'session');
  assert.equal(namespaceOf('host.listDirectory'), 'host');
  assert.equal(namespaceOf('commands/list'), 'commands');
  assert.equal(namespaceOf('pluginInventory/list'), 'pluginInventory');
});

test('planChecks probes one read method per namespace and nothing else', () => {
  const methods = ['session.list', 'session.history', 'session.prompt', 'host.describe', 'workspace.list'];
  const { probes, unchecked } = planChecks(methods);
  assert.deepEqual(probes.map((p) => p.method), ['host.describe', 'session.list', 'workspace.list']);
  for (const probe of probes) assert.ok(Object.hasOwn(PROBES, probe.method));
  assert.deepEqual(unchecked.map((u) => u.method), ['session.history', 'session.prompt']);
  assert.equal(unchecked.find((u) => u.method === 'session.history').readOnly, true);
  assert.equal(unchecked.find((u) => u.method === 'session.prompt').readOnly, false);
});

test('the page source yields a probe per namespace, all read-only', async () => {
  const source = await readFile(APP_PATH, 'utf8');
  const methods = extractMethods(source);
  assert.ok(methods.includes('host.describe'), 'app.js calls host.describe');
  const { probes, namespaces } = planChecks(methods);
  assert.ok(namespaces.length >= 7, `expected the app's namespaces, got ${namespaces.join(', ')}`);
  assert.equal(probes.length, namespaces.length, 'every namespace gets exactly one probe');
  for (const probe of probes) {
    assert.ok(Object.hasOwn(PROBES, probe.method), `${probe.method} is not an allowed probe`);
    assert.ok(!CHANGES_A_SESSION.includes(probe.method), `${probe.method} must never be called`);
  }
});

test('callRpc refuses any method outside the read-only probe list', async () => {
  await assert.rejects(
    () => callRpc('http://127.0.0.1:1', 'session.prompt', {}),
    /not on the read-only probe list/,
  );
});

// Endpoints the newer smoke must never send: they start, prompt, steer or change a session.
const NEWER_CHANGES_A_SESSION = [
  'session/prompt', 'session/cancel', 'session/create', 'session/rename', 'session/fork',
  'session/selectModel', 'session/updateQueue', 'workspace/archiveSession', 'workspace/create',
  'workspace/delete', 'goals/create', 'goals/edit', 'goals/pause', 'goals/complete',
  'goals/clear', 'commands/execute', 'job/kill', 'userQuestions/answer',
];

test('planNewerChecks probes one unary read per namespace the page maps onto, and the feeds', () => {
  const methods = [
    'session.list', 'session.prompt', 'agentPreset.list', 'host.listDirectory', 'workspace.list',
    'goals/get', 'commands/execute', 'pluginInventory/list', 'fileReferences/list',
  ];
  const { calls, streams, unchecked } = planNewerChecks(methods);
  assert.deepEqual(calls.map((c) => c.endpoint), [
    'agentPresets/list', 'commands/list', 'directoryPicker/list', 'fileReferences/list',
    'goals/get', 'pluginInventory/list', 'session/list',
  ]);
  for (const call of calls) {
    assert.ok(Object.hasOwn(NEWER_CALL_PROBES, call.endpoint), `${call.endpoint} is not on the call allowlist`);
    assert.ok(!NEWER_CHANGES_A_SESSION.includes(call.endpoint), `${call.endpoint} must never be sent`);
  }
  assert.ok(streams.some((s) => s.endpoint === 'session/control'));
  assert.ok(streams.some((s) => s.endpoint === 'workspace/follow'));
  for (const stream of streams) assert.ok(Object.hasOwn(NEWER_STREAM_PROBES, stream.endpoint));
  // The writes are reported as unchecked, never probed.
  assert.ok(unchecked.some((u) => u.method === 'session.prompt' && !u.readOnly));
  assert.ok(!calls.some((c) => NEWER_CHANGES_A_SESSION.includes(c.endpoint)));
});

test('planNewerChecks skips a namespace the page does not call', () => {
  const { calls } = planNewerChecks(['session.list']);
  assert.deepEqual(calls.map((c) => c.endpoint), ['session/list']);
});

test('callNewer and probeStream refuse anything outside the newer allowlists', async () => {
  await assert.rejects(
    () => callNewer('http://127.0.0.1:1', 'session/prompt', {}, {}),
    /not on the newer-API read-only probe list/,
  );
  await assert.rejects(
    () => probeStream('http://127.0.0.1:1', 'workspace/create', {}),
    /not on the newer-API feed probe list/,
  );
});

test('exchangeLaunchToken asks the token path and keeps the returned cookie', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), redirect: init.redirect });
    return { status: 303, headers: { getSetCookie: () => ['dsh-auth-x=v1.abc; Path=/; HttpOnly; SameSite=Strict'] } };
  };
  const out = await exchangeLaunchToken(new URL('http://127.0.0.1:3080'), 'tok 1/2', { fetchImpl });
  assert.equal(out.status, 303);
  assert.equal(out.cookie, 'dsh-auth-x=v1.abc');
  assert.equal(seen[0].url, 'http://127.0.0.1:3080/?token=tok%201%2F2');
  assert.equal(seen[0].redirect, 'manual');
});

test('every newer probe endpoint is referenced by the adapter or the page', async () => {
  const dsh02 = await readFile(new URL('../public/dsh02.js', import.meta.url), 'utf8');
  const app = await readFile(APP_PATH, 'utf8');
  const quoted = (source, endpoint) => source.includes(`'${endpoint}'`) || source.includes(`"${endpoint}"`);
  for (const endpoint of Object.keys(NEWER_CALL_PROBES)) {
    assert.ok(quoted(dsh02, endpoint) || quoted(app, endpoint), `${endpoint} is not called by public/dsh02.js or public/app.js`);
  }
  for (const endpoint of Object.keys(NEWER_STREAM_PROBES)) {
    assert.ok(quoted(dsh02, endpoint), `${endpoint} is not opened by public/dsh02.js`);
  }
});
