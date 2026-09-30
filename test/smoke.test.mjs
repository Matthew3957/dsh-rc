// The smoke script's pure parts: method extraction from the page source and the
// read-only probe plan. The live RPC calls are exercised by running the script against
// a dsh; these tests keep a broken extractor or a widened probe list from passing CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_PATH, PROBES, callRpc, extractMethods, namespaceOf, planChecks } from '../scripts/smoke.mjs';

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
