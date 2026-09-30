import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { encode, toTerminalLines, withQuietZone } from '../server/qr.mjs';

// A real decoder (jsQR + pngjs) is not a dependency of this repo. When a folder
// of node_modules that has it exists (DSH_RC_QR_TOOLS, or ../tools/node_modules
// beside the checkout's parent), the round-trip tests run; otherwise they skip.
const here = path.dirname(fileURLToPath(import.meta.url));
let jsQR = null;
for (const dir of [process.env.DSH_RC_QR_TOOLS, path.resolve(here, '../../tools/node_modules')].filter(Boolean)) {
  try {
    const req = createRequire(path.join(dir, 'x.js'));
    // jsQR 1.4 lists version 23's last alignment pattern at 74; ISO 18004 says 78
    // (the encoder's own layout is the standard one). Patch that one number in
    // memory so version 23 is still checked by the real decoder.
    const file = req.resolve('jsqr');
    const patched = fs.readFileSync(file, 'utf8').replace('[6, 30, 54, 74, 102]', '[6, 30, 54, 78, 102]');
    const mod = { exports: {} };
    vm.runInThisContext(`(function (module, exports, require) {${patched}\n})`, { filename: file })(mod, mod.exports, req);
    jsQR = mod.exports.default || mod.exports;
    break;
  } catch {}
}
const skip = jsQR ? false : 'jsqr is not installed (set DSH_RC_QR_TOOLS to a node_modules folder that has it)';

function decode(code, { scale = 4, quiet = 4 } = {}) {
  const rows = withQuietZone(code, quiet);
  const px = rows.length * scale;
  const data = new Uint8ClampedArray(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const v = rows[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255;
      data.set([v, v, v, 255], (y * px + x) * 4);
    }
  }
  const result = jsQR(data, px, px);
  return result && result.binaryData ? Buffer.from(result.binaryData).toString('utf8') : null;
}

// Deterministic pseudo-random text so failures reproduce.
function sample(length, seed) {
  let s = seed;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&()*+,;=%ABCXYZ';
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[s % alphabet.length];
  }
  return out;
}

test('a tunnel URL fits in a small code and the code is square', () => {
  const code = encode('https://fake-test-tunnel-name-here.trycloudflare.com/');
  assert.ok(code.version <= 4);
  assert.equal(code.size, code.version * 4 + 17);
  assert.equal(code.modules.length, code.size);
  assert.ok(code.modules.every((row) => row.length === code.size));
});

test('the three finder patterns and the dark module are in place', () => {
  const { modules, size } = encode('https://example.trycloudflare.com/');
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(modules[oy + y][ox + x], ring !== 2, `finder at ${ox},${oy} module ${x},${y}`);
      }
    }
  }
  assert.equal(modules[size - 8][8], true);
});

test('text too long for version 40 is refused, and so is an unknown level', () => {
  assert.throws(() => encode('x'.repeat(3000)), /too long/);
  assert.throws(() => encode('x', { ecc: 'Z' }), /unsupported/);
});

test('terminal output is two module rows per line, with or without ANSI', () => {
  const code = encode('https://example.trycloudflare.com/');
  const plain = toTerminalLines(code, { quiet: 2 });
  assert.equal(plain.length, Math.ceil((code.size + 4) / 2));
  assert.ok(plain.every((line) => [...line].length === code.size + 4));
  assert.ok(!plain.join('').includes('\u001b'));
  const ansi = toTerminalLines(code, { quiet: 2, ansi: true });
  assert.ok(ansi.every((line) => line.startsWith('\u001b[30;47m') && line.endsWith('\u001b[0m')));
});

test('terminal glyphs agree with the matrix', () => {
  const code = encode('https://example.trycloudflare.com/');
  const rows = withQuietZone(code, 2);
  rows.push(new Array(rows.length).fill(false));
  const lines = toTerminalLines(code, { quiet: 2, ansi: true }).map((l) => [...l.replace(/\u001b\[[0-9;]*m/g, '')]);
  const full = rows.length % 2 ? rows : rows;
  for (let y = 0; y < lines.length; y++) {
    for (let x = 0; x < lines[y].length; x++) {
      const top = full[y * 2][x];
      const bottom = full[y * 2 + 1] ? full[y * 2 + 1][x] : false;
      assert.equal(lines[y][x], [' ', '▄', '▀', '█'][(top ? 2 : 0) + (bottom ? 1 : 0)]);
    }
  }
});

test('many tunnel-shaped URLs decode back exactly', { skip }, () => {
  const words = ['alpha', 'quiet', 'river', 'maple', 'orbit', 'delta', 'ember', 'noble', 'harbor', 'violet', 'lantern', 'mosaic'];
  const urls = [];
  for (let n = 1; n <= 6; n++) {
    for (let i = 0; i < 12; i++) {
      const parts = [];
      for (let k = 0; k < n; k++) parts.push(words[(i * 5 + k * 3 + n) % words.length]);
      urls.push(`https://${parts.join('-')}.trycloudflare.com/`);
      urls.push(`https://${parts.join('-')}.trycloudflare.com`);
    }
  }
  urls.push('https://a.trycloudflare.com/', 'https://x.io/', 'http://127.0.0.1:3081/');
  for (const url of urls) assert.equal(decode(encode(url)), url, url);
});

for (const ecc of ['L', 'M']) {
  test(`every version 1-40 round-trips at level ${ecc}, at both ends of its capacity`, { skip }, () => {
    const seen = new Set();
    // The version needed grows with the length, so binary-search where each version starts.
    const versionAt = (len) => { try { return encode('a'.repeat(len), { ecc }).version; } catch { return 41; } };
    const lengths = new Set();
    for (let v = 1; v <= 40; v++) {
      let lo = 1, hi = 3000;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (versionAt(mid) >= v) hi = mid; else lo = mid + 1; }
      lengths.add(lo);
      if (lo > 1) lengths.add(lo - 1);
    }
    for (const len of [...lengths].sort((a, b) => a - b)) {
      const text = sample(len, len * 7 + 1);
      const code = encode(text, { ecc });
      seen.add(code.version);
      assert.equal(decode(code, { scale: 3 }), text, `level ${ecc}, ${len} bytes, version ${code.version}`);
    }
    assert.equal(seen.size, 40, `versions seen: ${[...seen].join(',')}`);
  });
}

test('non-ASCII text is encoded as UTF-8 bytes and decodes back', { skip }, () => {
  const text = 'https://example.trycloudflare.com/café/日本';
  assert.equal(decode(encode(text)), text);
});
