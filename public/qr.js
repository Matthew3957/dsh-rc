'use strict';
// A small QR Code encoder (byte mode, error correction L or M, versions 1-40),
// shared by the page and the server so the tunnel URL is drawn the same way in
// both. No dependencies. Follows ISO/IEC 18004: Reed-Solomon over GF(256) with
// polynomial 0x11D, the eight mask patterns scored by the four standard
// penalty rules, BCH-protected format and version information.
// test/qr.test.mjs decodes its output with a real decoder when one is available.
(function (root) {
  // Index 0 is version 1. Per error-correction level: codewords per block and block count.
  const ECC_PER_BLOCK = {
    L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  };
  const NUM_BLOCKS = {
    L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  };
  const FORMAT_BITS = { L: 1, M: 0 };

  const sizeOf = (version) => version * 4 + 17;

  function rawDataModules(version) {
    let n = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const align = Math.floor(version / 7) + 2;
      n -= (25 * align - 10) * align - 55;
      if (version >= 7) n -= 36;
    }
    return n;
  }
  const dataCodewords = (version, ecc) =>
    Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[ecc][version - 1] * NUM_BLOCKS[ecc][version - 1];

  // ---- Reed-Solomon ----
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    }
    return result;
  }

  function addEccAndInterleave(data, version, ecc) {
    const blocks = NUM_BLOCKS[ecc][version - 1];
    const eccLen = ECC_PER_BLOCK[ecc][version - 1];
    const rawCodewords = Math.floor(rawDataModules(version) / 8);
    const shortBlocks = blocks - (rawCodewords % blocks);
    const shortLen = Math.floor(rawCodewords / blocks);
    const divisor = rsDivisor(eccLen);
    const parts = [];
    for (let i = 0, k = 0; i < blocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
      k += dat.length;
      parts.push({ dat, ecc: rsRemainder(dat, divisor) });
    }
    const out = [];
    for (let i = 0; i < parts[parts.length - 1].dat.length; i++) {
      // Short blocks have one fewer data codeword, so skip their gap.
      parts.forEach((p) => { if (i < p.dat.length) out.push(p.dat[i]); });
    }
    for (let i = 0; i < eccLen; i++) parts.forEach((p) => out.push(p.ecc[i]));
    return out;
  }

  // ---- Matrix ----
  function alignmentPositions(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const out = [6];
    for (let pos = sizeOf(version) - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  function newGrid(size) {
    return Array.from({ length: size }, () => new Array(size).fill(false));
  }

  function drawFunctionPatterns(version, modules, isFn) {
    const size = modules.length;
    const set = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark;
      isFn[y][x] = true;
    };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const pos = alignmentPositions(version);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    drawFormat(modules, isFn, 'L', 0, true);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(a, b, dark); set(b, a, dark);
      }
    }
  }

  function drawFormat(modules, isFn, ecc, mask, reserveOnly) {
    const size = modules.length;
    const data = (FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => reserveOnly ? false : ((bits >>> i) & 1) !== 0;
    const set = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  }

  function placeCodewords(modules, isFn, codewords) {
    const size = modules.length;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && i < codewords.length * 8) {
            modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function applyMask(modules, isFn, mask) {
    for (let y = 0; y < modules.length; y++) {
      for (let x = 0; x < modules.length; x++) {
        if (!isFn[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
      }
    }
  }

  function penalty(modules) {
    const size = modules.length;
    let score = 0;
    const finderLike = (line, i) => {
      // 1:1:3:1:1 dark-light-dark-light-dark, with four light modules on either side.
      const at = (k) => line[k];
      const core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
      if (!core) return 0;
      const light = (from) => { for (let k = from; k < from + 4; k++) if (k >= 0 && k < size && at(k)) return false; return true; };
      return (light(i - 4) ? 40 : 0) + (light(i + 7) ? 40 : 0);
    };
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        const line = [];
        for (let b = 0; b < size; b++) line.push(pass === 0 ? modules[a][b] : modules[b][a]);
        let run = 1;
        for (let b = 1; b <= size; b++) {
          if (b < size && line[b] === line[b - 1]) { run++; continue; }
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
        for (let b = 0; b + 7 <= size; b++) score += finderLike(line, b);
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, 'utf8'));
  }

  /** Encode `text` as a QR code. Returns `{ size, version, modules }`, where
   *  `modules[y][x]` is true for a dark module. Throws if the text is too long. */
  function encode(text, { ecc = 'M' } = {}) {
    if (!ECC_PER_BLOCK[ecc]) throw new Error(`unsupported error correction level: ${ecc}`);
    const bytes = utf8(String(text));
    let version = 1;
    for (; version <= 40; version++) {
      const countBits = version <= 9 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= dataCodewords(version, ecc) * 8) break;
    }
    if (version > 40) throw new Error('text is too long for a QR code');

    const bits = [];
    const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0x4, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    bytes.forEach((b) => push(b, 8));
    const capacity = dataCodewords(version, ecc) * 8;
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);

    const size = sizeOf(version);
    const modules = newGrid(size);
    const isFn = newGrid(size);
    drawFunctionPatterns(version, modules, isFn);
    placeCodewords(modules, isFn, addEccAndInterleave(data, version, ecc));

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(modules, isFn, mask);
      drawFormat(modules, isFn, ecc, mask, false);
      const score = penalty(modules);
      if (!best || score < best.score) best = { score, mask, modules: modules.map((row) => row.slice()) };
      applyMask(modules, isFn, mask);
    }
    return { size, version, modules: best.modules };
  }

  /** The matrix with a quiet zone of `quiet` light modules on every side. */
  function withQuietZone(code, quiet = 4) {
    const size = code.size + quiet * 2;
    const rows = newGrid(size);
    for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) rows[y + quiet][x + quiet] = code.modules[y][x];
    return rows;
  }

  /** Draw a code onto a canvas: black on white, `scale` pixels per module. */
  function drawToCanvas(canvas, code, { scale = 6, quiet = 4 } = {}) {
    const rows = withQuietZone(code, quiet);
    canvas.width = canvas.height = rows.length * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    rows.forEach((row, y) => row.forEach((dark, x) => { if (dark) ctx.fillRect(x * scale, y * scale, scale, scale); }));
  }

  /** Text lines for a terminal, two module rows per line with half blocks.
   *  With `ansi` the code is black on white whatever the terminal theme;
   *  without it, light modules are the filled cells, which is right on the
   *  usual dark terminal and still scans on a light one. */
  function toTerminalLines(code, { quiet = 2, ansi = false } = {}) {
    const rows = withQuietZone(code, quiet);
    if (rows.length % 2) rows.push(new Array(rows.length).fill(false));
    // Index is top dark * 2 + bottom dark.
    const glyphs = ansi ? [' ', '▄', '▀', '█'] : ['█', '▀', '▄', ' '];
    const lines = [];
    for (let y = 0; y < rows.length; y += 2) {
      let line = '';
      for (let x = 0; x < rows[y].length; x++) line += glyphs[(rows[y][x] ? 2 : 0) + (rows[y + 1][x] ? 1 : 0)];
      lines.push(ansi ? `\u001b[30;47m${line}\u001b[0m` : line);
    }
    return lines;
  }

  root.dshQr = { encode, withQuietZone, drawToCanvas, toTerminalLines };
})(globalThis);
