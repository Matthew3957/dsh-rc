import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { findTunnelUrl, localOrigin, startTunnel } from '../server/tunnel.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function spawnWithFixturePath(fixture) {
  const dir = path.join(__dirname, 'fixtures', fixture);
  return (command, args, opts) =>
    spawn(command, args, { ...opts, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
}

test('startTunnel resolves the trycloudflare URL a fake cloudflared prints', async (t) => {
  const result = await startTunnel({ port: 3081, spawnFn: spawnWithFixturePath('cloudflared-ok') });
  t.after(() => result.stop());
  assert.equal(result.url, 'https://fake-test-tunnel.trycloudflare.com');
  assert.equal(typeof result.stop, 'function');
});

test('startTunnel rejects with a clear error when cloudflared is not on PATH', async () => {
  const noCloudflared = (command, args, opts) => spawn(command, args, { ...opts, env: { PATH: '/nonexistent' } });
  await assert.rejects(
    () => startTunnel({ port: 3081, spawnFn: noCloudflared }),
    /cloudflared not found on PATH/,
  );
});

test('startTunnel rejects when cloudflared exits before printing a URL, with its last output', async () => {
  await assert.rejects(
    () => startTunnel({ port: 3081, spawnFn: spawnWithFixturePath('cloudflared-fail') }),
    /exited before printing a tunnel URL[^]*some connector error/,
  );
});

test('stop() is idempotent', async () => {
  const result = await startTunnel({ port: 3081, spawnFn: spawnWithFixturePath('cloudflared-ok') });
  result.stop();
  result.stop(); // must not throw
});

test('findTunnelUrl skips the API host cloudflared names in its errors', () => {
  const failed = 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: timeout';
  assert.equal(findTunnelUrl(failed), null);
  assert.equal(findTunnelUrl(`${failed}\nINF |  https://some-words-here.trycloudflare.com  |`), 'https://some-words-here.trycloudflare.com');
});

test('cloudflared is started without self-update, pointed at this server', async () => {
  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push([command, args]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit('close', 0, null);
    };
    setImmediate(() => child.stderr.write('INF |  https://a-b-c.trycloudflare.com  |\n'));
    return child;
  };
  const tunnel = await startTunnel({ port: 4000, host: '::1', https: true, spawnFn: fakeSpawn });
  tunnel.stop();
  assert.deepEqual(calls, [['cloudflared', ['tunnel', '--no-autoupdate', '--url', 'https://[::1]:4000', '--no-tls-verify']]]);
  assert.equal(localOrigin({ host: '0.0.0.0', port: 3081 }), 'http://127.0.0.1:3081');
});

test('onExit fires when cloudflared dies after connecting, not after stop()', async () => {
  let exits = 0;
  const spawnFn = spawnWithFixturePath('cloudflared-ok');
  let child;
  const tracked = (...args) => (child = spawnFn(...args));

  await startTunnel({ port: 3081, spawnFn: tracked, onExit: () => { exits += 1; } }).then((tunnel) => {
    const exited = new Promise((resolve) => child.once('close', resolve));
    tunnel.stop();
    return exited;
  });
  assert.equal(exits, 0);

  const second = await startTunnel({ port: 3081, spawnFn: tracked, onExit: () => { exits += 1; } });
  const exited = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  await exited;
  assert.equal(exits, 1);
  second.stop();
});
