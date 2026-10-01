#!/usr/bin/env node
// Check that every dsh RPC method public/app.js calls still exists in a running dsh, on
// either dsh API.
//
// The page calls around 28 methods and has no tests, so a method renamed in a new dsh
// release only fails on the phone. This script extracts the method names from the page
// source. Against dsh 0.1.6 and earlier it calls host.describe, then one harmless read
// method per namespace. Against dsh 0.1.7 and later ("dsh 0.2") it exchanges the launch
// token for dsh's cookie, detects the API with session/canOpenWorkspacePath, then probes
// the 0.2 endpoints public/dsh02.js maps the page's calls onto: one harmless unary read per
// namespace and one harmless read of each mux feed the adapter opens. An unknown method
// answers HTTP 404 (unary) or gateway/invocation-unavailable (mux).
//
// It never calls a method that starts, prompts, steers or otherwise changes a session.
// The only requests it can send are the entries in PROBES, NEWER_CALL_PROBES and
// NEWER_STREAM_PROBES; the call helpers refuse anything else, and the payload builders
// follow the zod schemas in @deepseek-ai/dsh-host-apiproxy/lib/types/api for the older API
// (see the comments beside each PROBES entry) and the generated typert.remote-client.d.ts
// contracts for the newer one (dsh-api-session-controller, dsh-api-workspace-controller,
// dsh-agent-preset-registry, dsh-commands, dsh-host-plugin-inventory, dsh-goal,
// dsh-api-remotes and dsh-api-job-controller), plus dsh-api-gateway's stream-protocol.
//
// Usage:
//   node scripts/smoke.mjs [--url http://127.0.0.1:3080] [--app public/app.js]
//                          [--token <token>] [--token-file <file>]
//   DSH_URL is the default URL. It points at dsh web, not at dsh-rc's own port.
//   The launch token comes from --token/--token-file, or DSH_TOKEN/DSH_TOKEN_FILE, the
//   same sources the server reads. With no token the older API still works; the newer one
//   answers 401 and this script says so.
//
// Exit codes: 0 all probes exist, 1 an unknown method, 2 usage, parse, auth or connection error.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MUX_PATH } from '../public/dsh02.js';
import { parseSetCookies, tokenFrom } from '../server/dsh-auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_PATH = resolve(HERE, '..', 'public', 'app.js');
const DEFAULT_URL = 'http://127.0.0.1:3080';
const TIMEOUT_MS = 10_000;

// The only methods the older API path is allowed to call. Every one is a read: it starts no
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

// Namespaces the page only calls on the newer dsh API (0.1.7 and later), after it has detected
// one: listed, never probed on the older API, since an older dsh rightly answers 404 for them.
export const NEWER_API_ONLY = new Set(['goals']);

// Read-only methods the app calls that are deliberately not probed: one harmless read
// per namespace is enough for the smoke, and these need an existing session or path.
const READ_ONLY = new Set([
  'session.history', 'session.search', 'session.models', 'host.listDirectory',
]);

// A session id that names no real session, so probing with it cannot read or touch one.
// A fixed nil UUID keeps the output stable and can never collide with a real session.
const PLACEHOLDER_SESSION_ID = '00000000-0000-0000-0000-000000000000';

// The newer API's tell: only dsh 0.1.7 and later answer it.
const NEWER_DETECT = 'session/canOpenWorkspacePath';

// The newer API's unary reads, one per namespace, and the older-API method names dsh02.js
// maps onto each. `args` builds the endpoint's declared arguments: the gateway wraps them as
// payload {args}, exactly as public/dsh02.js's call() does.
//
// The contracts are typert.remote-client.d.ts in dsh-api-session-controller (session/list),
// dsh-api-workspace-controller (directoryPicker/list), dsh-agent-preset-registry
// (agentPresets/list), dsh-commands (commands/list), dsh-host-plugin-inventory
// (pluginInventory/list) and dsh-goal (goals/get), plus dsh-api-remotes'
// fileReferences/list.
export const NEWER_CALL_PROBES = Object.freeze({
  'session/list': {
    from: ['session.list', 'session.history', 'session.search', 'session.models', 'subagent.list'],
    args: () => ({ _request: {} }),
  },
  'directoryPicker/list': {
    from: ['host.listDirectory'],
    args: () => ({}),
  },
  'agentPresets/list': {
    from: ['agentPreset.list'],
    args: () => ({}),
  },
  'commands/list': {
    from: ['commands/list', 'commands/execute'],
    args: (ctx) => ({ agentId: ctx.placeholderSessionId }),
  },
  'pluginInventory/list': {
    from: ['pluginInventory/list'],
    args: () => ({}),
  },
  'fileReferences/list': {
    from: ['fileReferences/list'],
    args: (ctx) => ({ agentId: ctx.placeholderSessionId, query: '' }),
  },
  'goals/get': {
    from: ['goals/get', 'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear'],
    args: (ctx) => ({ agentId: ctx.placeholderSessionId }),
  },
});

// The mux feeds public/dsh02.js opens, one harmless read each, and the older-API method names
// they serve. A null `from` is a feed the adapter opens on every connection, so it is always
// checked. The opening snapshots for session/follow and job/follow name no real session or
// job; dsh answers session/not-found / gateway/internal, which still proves the feed exists.
//
// The framing is dsh-api-gateway's stream-protocol: `{type: 'open', streamId, endpoint,
// payload: {args}}` up, `item` / `error` / `end` down. The endpoints are the stream methods
// in the same typert.remote-client.d.ts contracts (session/control and session/follow in
// dsh-api-session-controller, workspace/follow in dsh-api-workspace-controller, job/list and
// job/follow in dsh-api-job-controller).
export const NEWER_STREAM_PROBES = Object.freeze({
  '$events': { from: null, args: () => ({}) },
  'session/control': {
    from: ['session.list', 'session.history', 'session.models', 'subagent.list'],
    args: () => ({}),
  },
  'session/follow': {
    from: ['session.history'],
    args: (ctx) => ({ request: { address: { kind: 'session', sessionId: ctx.placeholderSessionId }, assistantStream: true, maxMessages: 1 } }),
  },
  'workspace/follow': {
    from: ['workspace.list', 'workspace.archiveSession'],
    args: () => ({}),
  },
  'job/list': {
    from: null,
    args: (ctx) => ({ request: { sessionId: ctx.placeholderSessionId } }),
  },
  'job/follow': {
    from: null,
    args: (ctx) => ({ request: { sessionId: ctx.placeholderSessionId, jobId: ctx.placeholderSessionId } }),
  },
});

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
// per namespace and only ever from the PROBES allowlist. Older API only.
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
    const preferred = NEWER_API_ONLY.has(namespace) ? [] : (PROBE_ORDER[namespace] || []);
    const probe = preferred.find((m) => list.includes(m));
    if (probe) probes.push({ namespace, method: probe });
    for (const method of list) {
      if (method === probe) continue;
      const readOnly = Object.hasOwn(PROBES, method) || READ_ONLY.has(method);
      unchecked.push({ namespace, method, readOnly, newerOnly: NEWER_API_ONLY.has(namespace) });
    }
  }
  probes.sort((a, b) => a.method.localeCompare(b.method));
  unchecked.sort((a, b) => a.method.localeCompare(b.method));
  return { probes, unchecked, namespaces: [...byNamespace.keys()].filter((n) => !NEWER_API_ONLY.has(n)).sort() };
}

// The newer API's allowlisted reads: a call probe is included when the page calls one of the
// older-API methods it replaces, a feed probe when `from` names a call or is null (always on).
// `unchecked` is the page's methods no probe covers, so a rename there still takes a phone.
export function planNewerChecks(methods) {
  const present = new Set(methods);
  const inUse = (spec) => !spec.from || spec.from.some((m) => present.has(m));
  const calls = Object.entries(NEWER_CALL_PROBES)
    .filter(([, spec]) => inUse(spec))
    .map(([endpoint, spec]) => ({ endpoint, ...spec }))
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  const streams = Object.entries(NEWER_STREAM_PROBES)
    .filter(([, spec]) => inUse(spec))
    .map(([endpoint, spec]) => ({ endpoint, ...spec }))
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint));

  const covered = new Set(['host.describe']);
  for (const spec of [...Object.values(NEWER_CALL_PROBES), ...Object.values(NEWER_STREAM_PROBES)]) {
    for (const method of spec.from || []) covered.add(method);
  }
  const unchecked = methods
    .filter((method) => !covered.has(method))
    .map((method) => ({ method, readOnly: Object.hasOwn(PROBES, method) || READ_ONLY.has(method) }))
    .sort((a, b) => a.method.localeCompare(b.method));
  return { calls, streams, unchecked };
}

/**
 * Exchange the launch token dsh printed at start for its signed cookie. dsh 0.1.7 and later
 * gate every request behind it; dsh 0.1.6 and earlier ignore the token and answer the page
 * with no cookie, which this reports as a null cookie rather than an error.
 */
export async function exchangeLaunchToken(base, token, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const url = new URL('/?token=' + encodeURIComponent(token), base);
  const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const { cookie } = parseSetCookies(setCookies);
  return { status: res.status, cookie: cookie || null };
}

// One client-request. An unknown method answers HTTP 404, plain text, on both APIs.
async function postRpc(base, method, payload, { cookie, timeoutMs = TIMEOUT_MS } = {}) {
  const url = new URL('/api/' + method, base);
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* dsh answers plain text for unknown methods */ }
  return { status: res.status, ok: !!(json && json.result && json.result.ok), error: json && json.result && json.result.error, json };
}

export async function callRpc(base, method, payload, options = {}) {
  if (!Object.hasOwn(PROBES, method)) {
    throw new Error(`refusing to call ${method}: not on the read-only probe list`);
  }
  return postRpc(base, method, payload, options);
}

// A newer-API unary read. The payload is always {args}, as public/dsh02.js sends it.
export async function callNewer(base, endpoint, args, options = {}) {
  if (!Object.hasOwn(NEWER_CALL_PROBES, endpoint)) {
    throw new Error(`refusing to call ${endpoint}: not on the newer-API read-only probe list`);
  }
  return postRpc(base, endpoint, { args }, options);
}

/**
 * Open one mux feed and read its first frame. Resolves `{ok}` when dsh answered an item or a
 * non-gateway error (the feed exists), `{unknown: true}` when the gateway says no method
 * exports the endpoint, and `{ok: false, error}` for a socket or timeout failure.
 */
export async function probeStream(base, endpoint, args, { cookie, WebSocketImpl = globalThis.WebSocket, timeoutMs = TIMEOUT_MS } = {}) {
  if (!Object.hasOwn(NEWER_STREAM_PROBES, endpoint)) {
    throw new Error(`refusing to open ${endpoint}: not on the newer-API feed probe list`);
  }
  if (typeof WebSocketImpl !== 'function') return { ok: false, unsupported: true, error: { code: 'no-websocket' } };

  const wsUrl = new URL(MUX_PATH, base);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const streamId = 'probe';
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocketImpl(wsUrl.href, cookie ? { headers: { Cookie: cookie } } : {});
    } catch (e) {
      resolve({ ok: false, error: { code: 'socket-error', message: e.message } });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /* already closing */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: { code: 'timeout' } }), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (!m || m.streamId !== streamId) return;
      if (m.type === 'item' || m.type === 'end') finish({ ok: true });
      else if (m.type === 'error') finish({ ok: false, error: m.error, unknown: !!(m.error && m.error.code === 'gateway/invocation-unavailable') });
    };
    ws.onerror = (e) => finish({ ok: false, error: { code: 'socket-error', message: e && e.message } });
    ws.onclose = () => finish({ ok: false, error: { code: 'socket-closed' } });
  });
}

function parseArgs(argv) {
  const opts = {
    url: process.env.DSH_URL || DEFAULT_URL,
    app: APP_PATH,
    token: process.env.DSH_TOKEN || '',
    tokenFile: process.env.DSH_TOKEN_FILE || '',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--url') opts.url = argv[++i] || '';
    else if (arg.startsWith('--url=')) opts.url = arg.slice('--url='.length);
    else if (arg === '--app') opts.app = argv[++i] || '';
    else if (arg.startsWith('--app=')) opts.app = arg.slice('--app='.length);
    else if (arg === '--token') opts.token = argv[++i] || '';
    else if (arg.startsWith('--token=')) opts.token = arg.slice('--token='.length);
    // Both spellings of the file flag, matching the server's --dsh-token-file.
    else if (arg === '--token-file' || arg === '--dsh-token-file') opts.tokenFile = argv[++i] || '';
    else if (arg.startsWith('--token-file=')) opts.tokenFile = arg.slice('--token-file='.length);
    else if (arg.startsWith('--dsh-token-file=')) opts.tokenFile = arg.slice('--dsh-token-file='.length);
    else return { error: `unknown argument: ${arg}` };
  }
  return opts;
}

const USAGE = `Usage: node scripts/smoke.mjs [--url URL] [--app FILE] [--token TOKEN | --token-file FILE]

Extracts the dsh RPC method names from the page source, detects the dsh API, then calls
one harmless read per namespace and reports any unknown method or feed. On dsh 0.1.7 and
later it first exchanges the launch token for dsh's cookie; the token comes from --token
or --token-file, or DSH_TOKEN or DSH_TOKEN_FILE. DSH_URL sets the default URL
(${DEFAULT_URL}); --app defaults to public/app.js.`;

/** The 401 message: no token, a refused token, or a cookie dsh still rejected. */
function authProblem(base, token, exchange) {
  const origin = base.origin;
  if (!token) {
    console.error(`smoke: dsh answered 401 at ${origin}: the newer API gates everything behind its launch token.`);
    console.error('Set DSH_TOKEN or DSH_TOKEN_FILE to the token dsh printed at start, then try again.');
  } else if (exchange && exchange.cookie) {
    console.error(`smoke: dsh answered 401 at ${origin} even with the cookie from the launch token.`);
    console.error('The cookie is bound to the Host it was exchanged with; check --url matches how dsh is reached.');
  } else if (exchange && exchange.error) {
    console.error(`smoke: could not exchange the launch token with ${origin}: ${exchange.error.message}`);
    console.error('Check that dsh is still running and that DSH_URL is right.');
  } else {
    const status = exchange ? `HTTP ${exchange.status}` : 'no response';
    console.error(`smoke: dsh refused the launch token at ${origin} (${status}).`);
    console.error('Pass the token of the dsh that is running now (DSH_TOKEN or DSH_TOKEN_FILE).');
  }
  return 2;
}

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

  // The launch token, from the same sources and with the same precedence as the server:
  // the file wins, and both accept a bare token or the whole `?token=` URL.
  let token = null;
  if (opts.tokenFile) {
    let raw;
    try { raw = await readFile(opts.tokenFile, 'utf8'); }
    catch (e) { console.error(`smoke: cannot read the token file ${opts.tokenFile}: ${e.message}`); return 2; }
    token = tokenFrom(raw);
    if (!token) { console.error(`smoke: the token file ${opts.tokenFile} holds no token`); return 2; }
  } else if (opts.token) {
    token = tokenFrom(opts.token);
    if (!token) { console.error('smoke: the launch token is empty'); return 2; }
  }

  // Exchange before detecting: the cookie is what unblocks dsh 0.2, and a 0.1 dsh ignores it.
  let cookie = null;
  let exchange = null;
  if (token) {
    try { exchange = await exchangeLaunchToken(base, token); cookie = exchange.cookie; }
    catch (e) { exchange = { error: e }; }
  }

  const appLabel = opts.app === APP_PATH ? 'public/app.js' : opts.app;
  console.log(`dsh RPC smoke: ${base.origin}`);

  // The handshake. On 0.1 host.describe answers; on 0.2 it is a 404 and
  // session/canOpenWorkspacePath, which only the newer API has, is the tell.
  let describe;
  try { describe = await postRpc(base, 'host.describe', {}, { cookie }); }
  catch (e) {
    console.error(`smoke: cannot reach dsh at ${base.origin}: ${e.message}`);
    console.error('Start dsh web (or set DSH_URL) and try again.');
    return 2;
  }
  if (describe.status === 401) return authProblem(base, token, exchange);
  if (describe.status === 403) {
    console.error(`smoke: dsh answered 403 at ${base.origin}: it does not trust this Host or Origin.`);
    console.error('Start dsh with --trusted-host for the name it is reached by, and use a loopback URL here.');
    return 2;
  }

  let newer = false;
  if (describe.status === 404) {
    let detect;
    try { detect = await postRpc(base, NEWER_DETECT, { args: {} }, { cookie }); }
    catch (e) { console.error(`smoke: cannot reach dsh at ${base.origin}: ${e.message}`); return 2; }
    if (detect.status === 401) return authProblem(base, token, exchange);
    if (detect.status === 403) {
      console.error(`smoke: dsh answered 403 at ${base.origin}: it does not trust this Host or Origin.`);
      console.error('Start dsh with --trusted-host for the name it is reached by, and use a loopback URL here.');
      return 2;
    }
    if (detect.status === 404) {
      console.error(`smoke: neither the older dsh API (host.describe) nor the newer one (${NEWER_DETECT}) answered at ${base.origin}.`);
      return 1;
    }
    if (!detect.ok && detect.status >= 500) {
      console.error(`smoke: ${NEWER_DETECT} failed: ${detect.error ? detect.error.code : 'HTTP ' + detect.status}`);
      return 2;
    }
    newer = true;
  } else if (!describe.ok) {
    console.error(`smoke: host.describe failed: ${describe.error ? describe.error.code : 'HTTP ' + describe.status}`);
    return 2;
  }

  const ctx = { placeholderSessionId: PLACEHOLDER_SESSION_ID };

  if (!newer) {
    const { probes, unchecked, namespaces } = planChecks(methods);
    console.log(`app: ${appLabel} — ${methods.length} methods in ${namespaces.length} namespaces`);
    const version = describe.json.result.value && describe.json.result.value.version;
    console.log(`host: dsh ${version || '(version unknown)'}`);
    console.log('');

    // host.describe is the handshake and the host namespace's read probe, so it is cached
    // and not sent twice.
    const cache = new Map();
    const check = (method) => {
      if (!cache.has(method)) cache.set(method, callRpc(base, method, PROBES[method](ctx), { cookie }));
      return cache.get(method);
    };

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
      const newerOnly = unchecked.filter((u) => u.newerOnly).map((u) => u.method);
      const reads = unchecked.filter((u) => !u.newerOnly && u.readOnly).map((u) => u.method);
      const risky = unchecked.filter((u) => !u.newerOnly && !u.readOnly).map((u) => u.method);
      if (reads.length) console.log(`  read-only, not probed:  ${reads.join(', ')}`);
      if (newerOnly.length) console.log(`  newer dsh API only (0.1.7+), not probed here: ${newerOnly.join(', ')}`);
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

  // Newer API: probe the 0.2 endpoints public/dsh02.js maps the page's calls onto.
  const { calls, streams, unchecked } = planNewerChecks(methods);
  console.log(`app: ${appLabel} — ${methods.length} methods`);
  console.log(`api: newer dsh (0.1.7 and later) — ${calls.length} unary reads, ${streams.length} mux feeds`);
  console.log(`host: dsh (the newer API has no host.describe)`);
  console.log('');

  let unknown = 0;
  let broken = 0;
  let skipped = 0;

  console.log('probes (one harmless unary read per namespace public/dsh02.js maps onto)');
  for (const { endpoint } of calls) {
    let r;
    try { r = await callNewer(base, endpoint, NEWER_CALL_PROBES[endpoint].args(ctx), { cookie }); }
    catch (e) { console.log(`  ERR   ${endpoint.padEnd(24)} ${e.message}`); broken++; continue; }
    if (r.status === 404) {
      console.log(`  FAIL  ${endpoint.padEnd(24)} unknown endpoint (HTTP 404)`);
      unknown++;
    } else if (r.ok) {
      console.log(`  ok    ${endpoint.padEnd(24)}`);
    } else {
      console.log(`  ok    ${endpoint.padEnd(24)} (exists; answered ${r.error ? r.error.code : 'HTTP ' + r.status})`);
    }
  }

  console.log('');
  console.log('feeds (one harmless read per mux stream public/dsh02.js opens)');
  if (typeof WebSocket !== 'function') {
    skipped = streams.length;
    console.log('  skip  WebSocket is not available in this Node, so the mux feeds were not checked');
  } else {
    for (const { endpoint } of streams) {
      let r;
      try { r = await probeStream(base, endpoint, NEWER_STREAM_PROBES[endpoint].args(ctx), { cookie }); }
      catch (e) { console.log(`  ERR   ${endpoint.padEnd(24)} ${e.message}`); broken++; continue; }
      if (r.unsupported) {
        skipped++;
        console.log(`  skip  ${endpoint.padEnd(24)} WebSocket is not available`);
      } else if (r.unknown) {
        console.log(`  FAIL  ${endpoint.padEnd(24)} unknown feed (${r.error.code})`);
        unknown++;
      } else if (r.ok) {
        console.log(`  ok    ${endpoint.padEnd(24)}`);
      } else if (r.error && r.error.code === 'gateway/signature-invalid') {
        console.log(`  FAIL  ${endpoint.padEnd(24)} is a unary call, not a feed (${r.error.code})`);
        unknown++;
      } else if (r.error && ['socket-error', 'socket-closed', 'timeout'].includes(r.error.code)) {
        console.log(`  ERR   ${endpoint.padEnd(24)} ${r.error.code}`);
        broken++;
      } else {
        // A real feed answered with an application error (session/not-found for the
        // placeholder id, say): that still proves the endpoint exists.
        console.log(`  ok    ${endpoint.padEnd(24)} (exists; answered ${r.error ? r.error.code : '?'})`);
      }
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
  const total = calls.length + streams.length;
  if (unknown) {
    console.log(`${unknown} of ${total} probes failed: an endpoint was renamed or removed in this dsh.`);
    return 1;
  }
  if (broken) {
    console.log(`${broken} of ${total} probes could not be sent to ${base.origin}.`);
    return 2;
  }
  const checked = total - skipped;
  console.log(skipped
    ? `all ${checked} probes exist (${methods.length} methods extracted; ${skipped} feeds skipped).`
    : `all ${checked} probes exist (${methods.length} methods extracted).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error('smoke: ' + (e && e.stack || e)); process.exitCode = 2; },
  );
}
