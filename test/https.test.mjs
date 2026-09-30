import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

import { startServer } from '../server/index.mjs';

const quiet = { log() {}, error() {} };

async function selfSignedCert(dir) {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
  return { keyFile, certFile };
}

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('--cert/--key serve the page directly over https', { skip: !hasOpenssl() && 'openssl not available to make a test cert' }, async (t) => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rc-https-test-'));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  const { keyFile, certFile } = await selfSignedCert(stateDir);

  const app = await startServer({
    port: 0, host: '127.0.0.1', stateDir, sender: { send: async () => {} }, watch: false, logger: quiet,
    certFile, keyFile,
  });
  t.after(() => app.close());

  const body = await new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', port: app.port, path: '/', rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
  assert.equal(body.status, 200);
});
