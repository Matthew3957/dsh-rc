// Optional built-in Cloudflare Quick Tunnel: `--tunnel` / DSH_RC_TUNNEL=1
// spawns `cloudflared tunnel --no-autoupdate --url <this server>` and prints
// the public trycloudflare.com URL it reports on connect. cloudflared is never
// downloaded: if it is not on PATH, startTunnel rejects with a clear error.
// `--no-autoupdate` keeps cloudflared from replacing its own binary while it
// runs, which would be a download nobody asked for.
//
// There is no QR code: drawing one needs a QR library (a new dependency) or a
// hand-rolled encoder, and neither is worth it for a URL you can paste.

import { spawn } from 'node:child_process';

const TRYCLOUDFLARE_URL_RE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/gi;
/** Hostnames cloudflared mentions that are not the tunnel (its API, in errors). */
const NOT_A_TUNNEL = new Set(['api']);

/** The first tunnel URL in cloudflared's output so far, or null. */
export function findTunnelUrl(text) {
  for (const match of text.matchAll(TRYCLOUDFLARE_URL_RE)) {
    if (!NOT_A_TUNNEL.has(match[1].toLowerCase())) return match[0].toLowerCase();
  }
  return null;
}

function missingCloudflaredError(err) {
  if (err && err.code === 'ENOENT') {
    return new Error(
      'cloudflared not found on PATH. Install it from ' +
        'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ ' +
        '(dsh-rc never downloads it for you), then retry with --tunnel.',
    );
  }
  return err;
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode != null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
  const timer = setTimeout(() => {
    try {
      if (child.exitCode == null) child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 3000);
  if (timer.unref) timer.unref();
}

/** The local URL cloudflared should forward to. */
export function localOrigin({ host = '127.0.0.1', port, https = false }) {
  let target = host;
  if (target === '0.0.0.0' || target === '::' || target === '') target = '127.0.0.1';
  if (target.includes(':') && !target.startsWith('[')) target = `[${target}]`;
  return `${https ? 'https' : 'http'}://${target}:${port}`;
}

/**
 * Spawn cloudflared and resolve once it prints its public URL. Resolves with
 * `{ url, stop }`; `stop()` is idempotent and kills the tunnel process.
 * `onExit` is called if cloudflared dies after the URL was printed.
 */
export function startTunnel({
  port,
  host = '127.0.0.1',
  https = false,
  spawnFn = spawn,
  command = 'cloudflared',
  timeoutMs = 30_000,
  onExit = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    const args = ['tunnel', '--no-autoupdate', '--url', localOrigin({ host, port, https })];
    // Our own certificate is usually self-signed or for another name; the hop
    // is loopback, so skip verifying it.
    if (https) args.push('--no-tls-verify');
    let child;
    try {
      child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(missingCloudflaredError(err));
      return;
    }

    let settled = false;
    let stopping = false;
    let buffer = '';
    const stop = () => {
      stopping = true;
      stopChild(child);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error('cloudflared did not print a tunnel URL in time'));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    const onData = (chunk) => {
      if (settled) return;
      buffer = (buffer + chunk.toString('utf8')).slice(-8192);
      const url = findTunnelUrl(buffer);
      if (url) {
        settled = true;
        clearTimeout(timer);
        resolve({ url, stop });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(missingCloudflaredError(err));
    });
    // 'close', not 'exit': it waits for stdout/stderr to drain, so the error
    // below can quote cloudflared's last words.
    child.on('close', (code, signal) => {
      if (settled) {
        if (!stopping) onExit(code, signal);
        return;
      }
      settled = true;
      clearTimeout(timer);
      const tail = buffer.trim().split('\n').slice(-3).join('\n');
      reject(new Error(`cloudflared exited before printing a tunnel URL (code ${code}, signal ${signal})${tail ? `:\n${tail}` : ''}`));
    });
  });
}
