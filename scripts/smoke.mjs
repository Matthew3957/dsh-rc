#!/usr/bin/env node
// Check that every dsh RPC method public/app.js calls still exists in a running dsh.
//
// The page calls around 17 methods and has no tests, so a method renamed in a new dsh
// release only fails on the phone. This script extracts the method names from the page
// source, calls host.describe against dsh, then calls one harmless read method per
// namespace. An unknown method answers HTTP 404 ("not found").
//
// It never calls a method that starts, prompts, steers or otherwise changes a session.
// The only requests it can send are the entries in PROBES; callRpc refuses anything
// else, and the payload builders follow the zod schemas in
// @deepseek-ai/dsh-host-apiproxy/lib/types/api (see the comments beside each probe).
//
// Usage:
//   node scripts/smoke.mjs [--url http://127.0.0.1:3080] [--app public/app.js]
//   DSH_URL is the default URL. It points at dsh web, not at dsh-rc's own port.
//
// Exit codes: 0 all probes exist, 1 an unknown method, 2 usage, parse or connection error.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_PATH = resolve(HERE, '..', 'public', 'app.js');
const DEFAULT_URL = 'http://127.0.0.1:3080';
const TIMEOUT_MS = 10_000;

// The only methods this script is allowed to call. Every one is a read: it starts no
// turn, prompts nothing and writes nothing. Payloads are the exact shapes from the API
// schemas, so an "unknown method" answer is the only method-level failure possible.
export const PROBES = Object.freeze({
  // host.d.ts: describe(request: RpcRequest<{}>)
  'host.describe': () => ({}),
  // sessions.d.ts: list(request: RpcRequest<{ cursor?: string }>)
  'session.list': () => ({}),
  // workspace.d.ts: list(request: RpcRequest<{}>)
  'workspace.list': () => ({}),
  // agent-presets.d.ts: list(request: RpcRequest<{}>)
  'agentPreset.list': () => ({}),
  // subagents.d.ts: list(request: RpcRequest<{ parentSessionId: SessionId }>)
  'subagent.list': (ctx) => ({ parentSessionId: ctx.placeholderSessionId }),
  // Typert method (typert.remote-client.d.ts): POST payload { args: { agentId: SessionId } }
  'commands/list': (ctx) => ({ args: { agentId: ctx.placeholderSessionId } }),
  // Typert method: no arguments, but the envelope still needs one args field.
  'pluginInventory/list': () => ({ args: {} }),
  // Typert method (dsh-api-remotes client): { args: { agentId, query } }; read-only file lookup.
  'fileReferences/list': (ctx) => ({ args: { agentId: ctx.placeholderSessionId, query: '' } }),
});

// One probe per namespace, in preference order: the first method the app calls wins.
// Namespaces are the segment before the dot (core RPC) or slash (Typert).
const PROBE_ORDER = Object.freeze({
  host: ['host.describe'],
  session: ['session.list'],
  workspace: ['workspace.list'],
  agentPreset: ['agentPreset.list'],
  subagent: ['subagent.list'],
  commands: ['commands/list'],
  pluginInventory: ['pluginInventory/list'],
  fileReferences: ['fileReferences/list'],
});

// Read-only methods the app calls that are deliberately not probed: one harmless read
// per namespace is enough for the smoke, and these need an existing session or path.
const READ_ONLY = new Set([
  'session.history', 'session.search', 'session.models', 'host.listDirectory',
]);

// A session id that names no real session, so probing with it cannot read or touch one.
// A fixed nil UUID keeps the output stable and can never collide with a real session.
const PLACEHOLDER_SESSION_ID = '00000000-0000-0000-0000-000000000000';

export function namespaceOf(method) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)[./]/.exec(method);
  return m ? m[1] : '(none)';
}

// Method names passed as string literals to rpc(...) or remote(...), deduped and sorted.
// The rpc() definition takes a parameter, not a literal, so it never matches.
export function extractMethods(source) {
  const found = new Set();
  const re = /\b(?:rpc|remote)\(\s*(["'`])([A-Za-z][A-Za-z0-9_./-]*)\1/g;
  for (const match of source.matchAll(re)) found.add(match[2]);
  return [...found].sort();
}

// Split the app's methods into the probes to call and the ones left alone, one probe
// per namespace and only ever from the PROBES allowlist.
export function planChecks(methods) {
  const byNamespace = new Map();
  for (const method of methods) {
    const ns = namespaceOf(method);
    if (!byNamespace.has(ns)) byNamespace.set(ns, []);
    byNamespace.get(ns).push(method);
  }

  const probes = [];
  const unchecked = [];
  for (const [namespace, list] of byNamespace) {
    const preferred = PROBE_ORDER[namespace] || [];
    const probe = preferred.find((m) => list.includes(m));
    if (probe) probes.push({ namespace, method: probe });
    for (const method of list) {
      if (method === probe) continue;
      const readOnly = Object.hasOwn(PROBES, method) || READ_ONLY.has(method);
      unchecked.push({ namespace, method, readOnly });
    }
  }
  probes.sort((a, b) => a.method.localeCompare(b.method));
  unchecked.sort((a, b) => a.method.localeCompare(b.method));
  return { probes, unchecked, namespaces: [...byNamespace.keys()].sort() };
}

export async function callRpc(base, method, payload) {
  if (!Object.hasOwn(PROBES, method)) {
    throw new Error(`refusing to call ${method}: not on the read-only probe list`);
  }
  const url = new URL('/api/' + method, base);
  const rpcId = crypto.randomUUID();
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* dsh answers plain text for unknown methods */ }
  return { status: res.status, ok: !!(json && json.result && json.result.ok), error: json && json.result && json.result.error, json };
}

function parseArgs(argv) {
  const opts = { url: process.env.DSH_URL || DEFAULT_URL, app: APP_PATH, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--url') opts.url = argv[++i] || '';
    else if (arg.startsWith('--url=')) opts.url = arg.slice('--url='.length);
    else if (arg === '--app') opts.app = argv[++i] || '';
    else if (arg.startsWith('--app=')) opts.app = arg.slice('--app='.length);
    else return { error: `unknown argument: ${arg}` };
  }
  return opts;
}

const USAGE = `Usage: node scripts/smoke.mjs [--url URL] [--app FILE]

Extracts the dsh RPC method names from the page source, calls host.describe, then
calls one harmless read method per namespace and reports any unknown method.
DSH_URL sets the default URL (${DEFAULT_URL}); --app defaults to public/app.js.`;

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(`smoke: ${opts.error}\n\n${USAGE}`); return 2; }
  if (opts.help) { console.log(USAGE); return 0; }

  let base;
  try { base = new URL(opts.url); } catch { console.error(`smoke: invalid URL: ${opts.url}`); return 2; }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    console.error(`smoke: URL must be http or https: ${opts.url}`); return 2;
  }

  let source;
  try { source = await readFile(opts.app, 'utf8'); }
  catch (e) { console.error(`smoke: cannot read ${opts.app}: ${e.message}`); return 2; }

  const methods = extractMethods(source);
  if (!methods.length) {
    console.error(`smoke: no rpc(...) or remote(...) method names found in ${opts.app}`);
    return 2;
  }
  const { probes, unchecked, namespaces } = planChecks(methods);
  const appLabel = opts.app === APP_PATH ? 'public/app.js' : opts.app;
  console.log(`dsh RPC smoke: ${base.origin}`);
  console.log(`app: ${appLabel} — ${methods.length} methods in ${namespaces.length} namespaces`);

  // The handshake: proves dsh is reachable and reports the host version. It is also the
  // host namespace's read probe, so it is cached and not sent twice.
  const cache = new Map();
  const ctx = { placeholderSessionId: PLACEHOLDER_SESSION_ID };
  const check = async (method) => {
    if (!cache.has(method)) cache.set(method, callRpc(base, method, PROBES[method](ctx)));
    return cache.get(method);
  };

  let describe;
  try { describe = await check('host.describe'); }
  catch (e) {
    console.error(`smoke: cannot reach dsh at ${base.origin}: ${e.message}`);
    console.error('Start dsh web (or set DSH_URL) and try again.');
    return 2;
  }
  if (describe.status === 404) {
    console.error('smoke: host.describe is unknown to this dsh (HTTP 404)');
    return 1;
  }
  if (describe.status === 401) {
    console.error(`smoke: dsh answered 401 at ${base.origin}: the API needs authentication.`);
    console.error('dsh 0.2.x gates dsh web behind the token in its startup URL, which dsh-rc does not send yet.');
    return 2;
  }
  if (describe.status === 403) {
    console.error(`smoke: dsh answered 403 at ${base.origin}: it does not trust this Host or Origin.`);
    console.error('Start dsh with --trusted-host for the name it is reached by, and use a loopback URL here.');
    return 2;
  }
  if (!describe.ok) {
    console.error(`smoke: host.describe failed: ${describe.error ? describe.error.code : 'HTTP ' + describe.status}`);
    return 2;
  }
  const version = describe.json.result.value && describe.json.result.value.version;
  console.log(`host: dsh ${version || '(version unknown)'}`);
  console.log('');

  console.log('probes (one harmless read per namespace)');
  let unknown = 0;
  let broken = 0;
  for (const { namespace, method } of probes) {
    let r;
    try { r = await check(method); }
    catch (e) { console.log(`  ERR   ${method.padEnd(22)} ${namespace}: ${e.message}`); broken++; continue; }
    if (r.status === 404) {
      console.log(`  FAIL  ${method.padEnd(22)} ${namespace}: unknown method (HTTP 404)`);
      unknown++;
    } else if (r.ok) {
      console.log(`  ok    ${method.padEnd(22)} ${namespace}`);
    } else {
      // Any answer other than 404 proves the method exists. Only the code is shown:
      // server messages can carry host paths or session ids that should not be logged.
      console.log(`  ok    ${method.padEnd(22)} ${namespace} (exists; answered ${r.error ? r.error.code : 'HTTP ' + r.status})`);
    }
  }

  if (unchecked.length) {
    console.log('');
    console.log('not called by this smoke');
    const reads = unchecked.filter((u) => u.readOnly).map((u) => u.method);
    const risky = unchecked.filter((u) => !u.readOnly).map((u) => u.method);
    if (reads.length) console.log(`  read-only, not probed:  ${reads.join(', ')}`);
    if (risky.length) console.log(`  could start, prompt or change a session: ${risky.join(', ')}`);
  }

  console.log('');
  if (unknown) {
    console.log(`${unknown} of ${probes.length} probes failed: a method was renamed or removed in this dsh.`);
    return 1;
  }
  if (broken) {
    console.log(`${broken} of ${probes.length} probes could not be sent to ${base.origin}.`);
    return 2;
  }
  console.log(`all ${probes.length} probes exist (${methods.length} methods extracted).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error('smoke: ' + (e && e.stack || e)); process.exitCode = 2; },
  );
}
