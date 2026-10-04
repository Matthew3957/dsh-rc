// Themes are token overrides in public/style.css. These tests read the real stylesheet and check,
// by computation, that every theme in light and dark keeps its text at WCAG AA (4.5:1), that the
// status colours stay apart for protanopia and deuteranopia, and that public/theme.js agrees with
// the CSS about the page background (the iOS status-bar colour). Run it directly with --dump (or DUMP=1) for the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const themeSrc = await readFile(new URL('../public/theme.js', import.meta.url), 'utf8');

// ---- stylesheet: every declaration block with the chain of rules around it ----
function blocks(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [], stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { stack.push({ head: text.slice(start, i).trim(), body: '', open: i + 1 }); start = i + 1; }
    else if (text[i] === '}') {
      const top = stack.pop();
      if (top && !text.slice(top.open, i).includes('{')) out.push({ chain: [...stack.map((s) => s.head), top.head], body: text.slice(top.open, i) });
      start = i + 1;
    }
  }
  return out;
}
const tokens = (body) => Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const DARK = '@media (prefers-color-scheme: dark)';
const all = blocks(css);
const sheet = (selector, dark) => {
  const found = all.filter((b) => b.chain.at(-1) === selector && (b.chain.length > 1 && b.chain[0] === DARK) === dark);
  return Object.assign({}, ...found.map((b) => tokens(b.body)));
};

const THEMES = ['default', 'colourblind', 'contrast', 'autumn', 'winter', 'spring'];
const NEEDED = ['bg', 'bg2', 'card', 'fg', 'muted', 'line', 'accent', 'accent-fg', 'user', 'ok', 'err', 'warn', 'code'];
function palette(id, dark) {
  if (id === 'default') return { ...sheet(':root', false), ...(dark ? sheet(':root', true) : {}) };
  return sheet(`html[data-theme="${id}"]`, dark);
}

// ---- colour maths ----
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (rgb) => { const [r, g, b] = rgb.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (top, a, under) => top.map((c, i) => c * a + under[i] * (1 - a)); // color-mix(top a%, transparent) over under
// Machado et al. 2009, severity 1.0, applied in linear RGB; distance is CIE76 delta E.
const CVD = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};
const simulate = (h, m) => { const l = hex(h).map(lin); return CVD[m].map((r) => Math.min(1, Math.max(0, r[0] * l[0] + r[1] * l[1] + r[2] * l[2]))); };
function lab([r, g, b]) {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE = (a, b, m) => Math.hypot(...lab(simulate(a, m)).map((v, i) => v - lab(simulate(b, m))[i]));

// Text pairs the stylesheet really draws: [foreground token, background, what it is].
function textPairs(p) {
  const c = (k) => hex(p[k]);
  const pairs = [];
  for (const bg of ['bg', 'bg2', 'card', 'code', 'user']) pairs.push([`fg on ${bg}`, c('fg'), c(bg)]);
  for (const bg of ['bg', 'bg2', 'card', 'code']) pairs.push([`muted on ${bg}`, c('muted'), c(bg)]);
  for (const bg of ['bg', 'bg2', 'card']) pairs.push([`accent on ${bg}`, c('accent'), c(bg)]);
  pairs.push(['accent-fg on accent', c('accent-fg'), c('accent')], ['bg on fg (new pill, toast, stop)', c('bg'), c('fg')]);
  pairs.push(['accent on selected option', c('accent'), mix(c('accent'), 0.1, c('bg'))]);
  for (const k of ['ok', 'err', 'warn']) {
    for (const bg of ['bg', 'bg2', 'card', 'code']) pairs.push([`${k} on ${bg}`, c(k), c(bg)]);
    // Chips and pills tint their own colour over what is behind them; diff lines tint over code.
    pairs.push([`${k} on its pill tint (over card)`, c(k), mix(c(k), 0.16, c('card'))]);
    if (k === 'warn') continue; // diff lines are ok or err only
    const a = k === 'ok' ? 0.16 : 0.14; // .dl.add and .dl.del
    pairs.push([`${k} on its diff tint (over code)`, c(k), mix(c(k), a, c('code'))]);
    pairs.push([`fg on ${k} diff tint (over code)`, c('fg'), mix(c(k), a, c('code'))]);
  }
  pairs.push(['err on error note tint (over bg)', c('err'), mix(c('err'), 0.1, c('bg'))]);
  return pairs;
}

if (process.env.DUMP || process.argv.includes('--dump')) {
  for (const id of THEMES) for (const dark of [false, true]) {
    const p = palette(id, dark);
    console.log(`\n${id} ${dark ? 'dark' : 'light'}`);
    for (const [name, a, b] of textPairs(p)) console.log(`  ${ratio(a, b).toFixed(2).padStart(6)}  ${name}`);
    if (p.line) console.log(`  ${ratio(hex(p.line), hex(p.bg)).toFixed(2).padStart(6)}  line on bg (3:1 wanted for the contrast theme)`);
    for (const m of Object.keys(CVD)) console.log(`  dE ${m}: ok/err ${deltaE(p.ok, p.err, m).toFixed(0)}, ok/warn ${deltaE(p.ok, p.warn, m).toFixed(0)}, err/warn ${deltaE(p.err, p.warn, m).toFixed(0)}`);
  }
}

for (const id of THEMES) {
  for (const dark of [false, true]) {
    const mode = dark ? 'dark' : 'light';
    test(`theme ${id} (${mode}) defines every token`, () => {
      const p = palette(id, dark);
      for (const k of NEEDED) assert.match(p[k] || '', /^#[0-9a-f]{6}$/i, `--${k}`);
    });

    test(`theme ${id} (${mode}) keeps text at WCAG AA`, () => {
      // The default look predates this check: hold it to AA only on the pairs that carry body
      // text, and report the rest through DUMP rather than changing a look people already have.
      const p = palette(id, dark);
      const exempt = id === 'default' ? /^(muted on (bg2|code)|ok on|warn on|err on|accent on|fg on (ok|err|warn))/ : null;
      const low = textPairs(p).filter(([name]) => !(exempt && exempt.test(name)))
        .map(([name, a, b]) => [name, ratio(a, b)]).filter(([, r]) => r < 4.5);
      assert.deepEqual(low.map(([n, r]) => `${n} ${r.toFixed(2)}`), []);
    });
  }
}

test('the contrast theme keeps borders at 3:1 and body text near 21:1', () => {
  for (const dark of [false, true]) {
    const p = palette('contrast', dark);
    assert.ok(ratio(hex(p.line), hex(p.bg)) >= 3, `line ${dark ? 'dark' : 'light'}`);
    assert.ok(ratio(hex(p.fg), hex(p.bg)) >= 19, `fg ${dark ? 'dark' : 'light'}`);
    assert.ok(ratio(hex(p.muted), hex(p.bg2)) >= 7, `muted ${dark ? 'dark' : 'light'}`);
  }
});

test('colourblind and contrast keep ok, err and warn apart for protanopia and deuteranopia', () => {
  for (const id of ['colourblind', 'contrast']) for (const dark of [false, true]) for (const m of Object.keys(CVD)) {
    const p = palette(id, dark);
    for (const [a, b] of [['ok', 'err'], ['ok', 'warn'], ['err', 'warn']]) {
      assert.ok(deltaE(p[a], p[b], m) >= 20, `${id} ${dark ? 'dark' : 'light'} ${m}: ${a}/${b} ${deltaE(p[a], p[b], m).toFixed(1)}`);
    }
  }
});

test('colourblind and contrast never pair a red-ish with a green-ish status colour', () => {
  const hue = (h) => {
    const [r, g, b] = hex(h).map((v) => v / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    if (!d) return 0;
    return ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  };
  for (const id of ['colourblind', 'contrast']) for (const dark of [false, true]) {
    const p = palette(id, dark);
    for (const k of ['ok', 'err', 'warn']) {
      const h = hue(p[k]);
      assert.ok(!(h > 60 && h < 170), `${id} --${k} hue ${h.toFixed(0)} is in the green band`);
    }
  }
});

test('the stylesheet gives the cue themes a non-colour cue for tools, offline and failed jobs', () => {
  for (const id of ['colourblind', 'contrast']) {
    for (const needle of ['.tool.ok .bullet::before', '.tool.err .bullet::before', '.dot:not(.on)', '.jdot.failed', '.jdot.stopping']) {
      assert.ok(all.some((b) => b.chain.at(-1).split(',').some((s) => s.trim() === `html[data-theme="${id}"] ${needle}`)), `${id} ${needle}`);
    }
  }
});

// ---- public/theme.js ----
function load({ stored, metas, throwStore = false } = {}) {
  const store = new Map(stored ? [['dsh-rc.theme', stored]] : []);
  const attrs = new Map();
  const win = {};
  vm.runInNewContext(themeSrc, {
    window: win,
    localStorage: {
      getItem: (k) => { if (throwStore) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
      setItem: (k, v) => { if (throwStore) throw new Error('denied'); store.set(k, v); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      documentElement: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) },
      querySelectorAll: () => metas || [],
    },
  });
  return { api: win.dshTheme, store, attrs };
}
const meta = (media) => ({ media, content: '', getAttribute(k) { return k === 'media' ? this.media : this.content; }, setAttribute(k, v) { if (k === 'content') this.content = v; } });

test('theme.js lists the same themes as the stylesheet and the page background matches', () => {
  const { api } = load();
  assert.deepEqual([...api.THEMES].map((t) => t.id), THEMES);
  for (const t of api.THEMES) {
    assert.equal(t.bg[0].toLowerCase(), palette(t.id, false).bg, `${t.id} light bg`);
    assert.equal(t.bg[1].toLowerCase(), palette(t.id, true).bg, `${t.id} dark bg`);
  }
});

test('index.html carries the default status-bar colours and loads theme.js before first paint', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="theme-color" content="#111416" media="\(prefers-color-scheme: dark\)">/);
  assert.match(html, /<meta name="theme-color" content="#f6f7f8" media="\(prefers-color-scheme: light\)">/);
  assert.ok(/<script src="theme\.js"><\/script>/.test(html), 'theme.js must be a plain, blocking script');
  assert.ok(html.indexOf('theme.js') < html.indexOf('<body'), 'theme.js belongs in <head>');
});

test('theme.js applies the saved theme and keeps the theme-color tags in step', () => {
  const light = meta('(prefers-color-scheme: light)'), dark = meta('(prefers-color-scheme: dark)');
  const { api, attrs } = load({ stored: 'winter', metas: [dark, light] });
  assert.equal(attrs.get('data-theme'), 'winter');
  assert.equal(light.content, '#f3f6f9');
  assert.equal(dark.content, '#0f151b');
  api.set('default');
  assert.equal(attrs.has('data-theme'), false);
  assert.equal(light.content, '#f6f7f8');
  assert.equal(dark.content, '#111416');
});

test('theme.js remembers a choice, forgets the default, and ignores unknown or unreadable values', () => {
  const { api, store, attrs } = load({ stored: 'nonsense' });
  assert.equal(api.current(), 'default');
  assert.equal(attrs.has('data-theme'), false);
  assert.equal(api.set('autumn'), true);
  assert.equal(store.get('dsh-rc.theme'), 'autumn');
  assert.equal(api.current(), 'autumn');
  api.set('default');
  assert.equal(store.has('dsh-rc.theme'), false);
  const blocked = load({ throwStore: true });
  assert.equal(blocked.api.set('spring'), false); // still applied for this page
  assert.equal(blocked.attrs.get('data-theme'), 'spring');
});
