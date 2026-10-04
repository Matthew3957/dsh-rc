// Switching connectors from the phone (#70): the one hole in the proxy's refusal of dsh 0.2's
// `pluginManager` namespace.
//
// dsh itself answers every `pluginManager` method for the Host the proxy presents, including
// switching off core plugins and installing packages, so dsh-rc decides what gets through:
//
//   - `pluginManager/listPlugins`, read-only, so the page knows which rows dsh will change.
//   - `pluginManager/setPluginEnabled`, only for an entry already in the profile that is an MCP
//     connector or a subagent provider (`pluginKind` in public/dsh02.js, shared with the page)
//     and that dsh lists with a patch target. The proxy reads the list from dsh itself, checks
//     the entry, and forwards a body it rebuilt from the checked fields, never the page's bytes.
//
// Everything else in the namespace stays refused (see PRIVILEGED_METHOD in proxy.mjs).
// Adding a connector is not here: dsh 0.2 has no remote method that adds a loader entry (MCP
// servers are `cordis.yml` rows, written by the host-side config editor), so a phone cannot add
// one, stdio or remote, through this proxy.
//
// Both methods also need dsh-rc's own login, or a loopback or Tailscale (`*.ts.net`) Host when
// the login is off. Without a login the Host fence (checkRequest) already allows only loopback and
// `--trusted-host` names; this narrows it further, so a LAN name trusted for reading cannot
// change the profile.

import { pluginKind } from '../public/dsh02.js';
import { hostnameOf, isLoopbackHostname } from './proxy.mjs';

export const LIST_METHOD = 'pluginManager/listPlugins';
export const TOGGLE_METHOD = 'pluginManager/setPluginEnabled';
export const PLUGIN_CHANGE_METHODS = new Set([LIST_METHOD, TOGGLE_METHOD]);

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keysAre = (v, allowed, required = allowed) =>
  Object.keys(v).every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(v, k));

/** A Tailscale MagicDNS name: what Tailscale Serve forwards as the Host. */
export function isTailnetHostname(hostname) {
  return typeof hostname === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(hostname);
}

/** Null when this request may use the plugin methods, or the reason it may not. */
export function pluginChangeRefusal(req, { authEnabled }) {
  if (authEnabled) return null;
  const hostname = hostnameOf(req.headers.host);
  if (isLoopbackHostname(hostname) || isTailnetHostname(hostname)) return null;
  return "switching plugins needs dsh-rc's login, or a loopback or Tailscale address";
}

/**
 * The page's `setPluginEnabled` request, or `{error}`. Only the exact shape the page sends is
 * accepted: `{type: 'client-request', rpcId, method, payload: {args: {id, enabled}}}`.
 */
export function parseToggle(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!plain(body) || !keysAre(body, ['type', 'rpcId', 'method', 'payload'])) return { error: 'not a client request' };
  if (body.type !== 'client-request' || body.method !== TOGGLE_METHOD) return { error: 'not a client request' };
  const { rpcId } = body;
  if (!(typeof rpcId === 'string' && rpcId.length <= 128) && !Number.isSafeInteger(rpcId)) return { error: 'bad rpcId' };
  if (!plain(body.payload) || !keysAre(body.payload, ['args'])) return { error: 'payload must be {args}' };
  const args = body.payload.args;
  if (!plain(args) || !keysAre(args, ['id', 'enabled'])) return { error: 'args must be exactly {id, enabled}' };
  if (typeof args.id !== 'string' || !args.id || args.id.length > 512) return { error: 'id must be a plugin entry id' };
  if (typeof args.enabled !== 'boolean') return { error: 'enabled must be true or false' };
  return { rpcId, id: args.id, enabled: args.enabled };
}

/** Null when `listPlugins` shows `id` as a row the phone may switch, or the reason it may not. */
export function toggleRefusal(list, id) {
  const entry = (Array.isArray(list) ? list : []).find((e) => plain(e) && e.entryId === id);
  if (!entry) return 'no such plugin in this profile';
  if (!pluginKind(entry)) return 'only MCP connectors and subagent providers can be switched from the phone';
  if (entry.readOnlyReason || typeof entry.patchId !== 'string') return `dsh keeps this entry read-only (${entry.readOnlyReason || 'no patch target'})`;
  return null;
}

/** The body forwarded to dsh: rebuilt from the checked fields only. */
export function toggleBody({ rpcId, id, enabled }) {
  return JSON.stringify({ type: 'client-request', rpcId, method: TOGGLE_METHOD, payload: { args: { id, enabled } } });
}
