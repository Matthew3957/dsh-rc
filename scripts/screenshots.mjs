#!/usr/bin/env node
// Regenerate the README screenshots (docs/screenshots/*.png) from the demo sessions.
//
// It starts the mock dsh (scripts/demo-dsh.mjs) and dsh-rc's own server in front of it,
// opens the page in a headless Chromium at phone size and saves one PNG per scene. No
// real dsh is ever contacted, and the browser clock is pinned, so the output is the same
// on every run.
//
// A browser is not a dependency of this repo. Point the script at one you have:
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core   the playwright-core package directory
//   CHROMIUM_PATH=/path/to/chrome                           optional; playwright's own browser otherwise
//
// Usage:
//   PLAYWRIGHT_CORE=... node scripts/screenshots.mjs [--out docs/screenshots] [--scale 2] [--only sessions,chat]
//                                                    [--scheme dark|light] [--theme <id>] [--width 390]
//
// The README set is the default: dark scheme, default theme, 390px wide. --scheme, --theme and
// --width render the same scenes in any theme, either scheme and another phone width (320 and
// 430 are worth a look), for review, without committing them:
//   for s in light dark; do for t in default colourblind contrast; do
//     node scripts/screenshots.mjs --scheme $s --theme $t --out /tmp/shots/$t-$s; done; done
//
// Checks (docs/design/2026-11-14-redesign.md, PR 7), on top of the pictures:
//   --audit            a tap-target audit of every scene, plus a few audit-only states (the
//                      session menu, New session, search, the plus menu, Queue/Steer while a
//                      turn runs, Notifications). Every button, link, field, summary and
//                      [role] control on screen must have a hit box of at least 44 by 44,
//                      measured by probing what a tap at each point would land on (so a
//                      padded or pseudo-element hit box counts, and a switch counts its whole
//                      label row). Links inside prose are exempt. It also fails a control
//                      with no accessible name, and any console error. Exits 1 on a failure.
//   --reduced-motion   renders with prefers-reduced-motion: reduce and fails if anything on
//                      the page could still move: a transition or animation on transform, an
//                      animation other than the working glyph and the fades, or a script
//                      animation whose keyframes change a transform.
// Audit-only states are saved as pictures too, but only when --out points somewhere other than
// docs/screenshots.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startDemoDsh } from './demo-dsh.mjs';
import { startServer } from '../server/index.mjs';
import { ID } from './demo-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 390;
const HEIGHT = 844;
// A Thursday afternoon, far from any real session: every fixture time is relative to it.
const NOW = Date.UTC(2026, 0, 15, 14, 30, 0);

// The theme ids public/theme.js offers, read from its THEMES table so the two cannot drift.
function themeIds() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'theme.js'), 'utf8');
  return [...src.matchAll(/\{\s*id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'docs', 'screenshots'), outExplicit: false, scale: 2, only: null, scheme: 'dark', theme: 'default', width: WIDTH, audit: false, reducedMotion: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { out.out = path.resolve(argv[++i]); out.outExplicit = true; }
    else if (a === '--audit') out.audit = true;
    else if (a === '--reduced-motion') out.reducedMotion = true;
    else if (a === '--scale') out.scale = Number(argv[++i]);
    else if (a === '--width') {
      out.width = Number(argv[++i]);
      if (!(out.width >= 320 && out.width <= 1280)) throw new Error('--width must be between 320 and 1280');
    }
    else if (a === '--scheme') {
      out.scheme = String(argv[++i]);
      if (!['dark', 'light'].includes(out.scheme)) throw new Error('--scheme must be dark or light');
    }
    else if (a === '--theme') {
      out.theme = String(argv[++i]);
      const ids = themeIds();
      if (!ids.includes(out.theme)) throw new Error(`unknown theme ${out.theme}; themes: ${ids.join(', ')}`);
    }
    else if (a === '--only') {
      out.only = new Set(String(argv[++i]).split(',').filter(Boolean));
      const known = new Set(SCENES.concat(AUDIT_SCENES).map((s) => s.name));
      const bad = [...out.only].filter((n) => !known.has(n));
      if (bad.length) throw new Error(`unknown scene ${bad.join(', ')}; scenes: ${[...known].join(', ')}`);
    }
    else throw new Error(`unknown option ${a}`);
  }
  if (!(out.scale >= 1 && out.scale <= 3)) throw new Error('--scale must be between 1 and 3');
  return out;
}

function loadChromium() {
  const dir = process.env.PLAYWRIGHT_CORE;
  if (!dir) throw new Error('set PLAYWRIGHT_CORE to the playwright-core package directory (see the header of this file)');
  return createRequire(path.join(path.resolve(dir), 'noop.js'))(path.resolve(dir)).chromium;
}

// Each scene opens the page fresh and leaves it at the state worth a picture.
// `pending` raises the approval and plan cards the mock replays when the page connects.
// `storage` is this device's saved state before first paint, as app.js reads it.
const SCENES = [
  {
    // The whole board: the approval and the plan review in Needs you, the TOML migration in
    // Running now, one finished session not yet read, one that failed earlier today, and the
    // rest under Earlier.
    name: 'sessions',
    pending: { approval: true, plan: true },
    storage: (now) => {
      const seen = Object.fromEntries(Object.values(ID).filter((id) => id !== ID.offByOne).map((id) => [id, now]));
      return { 'dshm.seen': JSON.stringify(seen), 'dshm.seededAt': String(now - 2 * 3600_000), 'dshm.failed': JSON.stringify({ [ID.lint]: now - 3 * 3600_000 }) };
    },
    async run(page, ctx) {
      await ctx.open('/');
      await page.waitForSelector('#pendingGlobal .sess >> nth=1');
      await page.waitForSelector('#pendingGlobal .ask-sum:has-text("npm run build && npm test")');
      await page.waitForSelector(`#runningCards .run-row[data-session="${ID.toml}"]`);
      await page.waitForSelector('#sessions .sess >> nth=4');
    },
  },
  {
    // Running now with the pagination session's jobs and subagents open under its live row.
    name: 'running',
    async run(page, ctx) {
      await ctx.open('/');
      await page.waitForSelector('.run-row .run-more-txt:has-text("subagent")');
      await page.click(`.run-row[data-session="${ID.pagination}"] .run-more`);
      await page.waitForSelector('.run-agent');
    },
  },
  {
    name: 'chat',
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.offByOne);
      await page.waitForSelector('.turncard');
      await page.waitForTimeout(300); // the page scrolls to the bottom on its own after rendering
      await page.evaluate(() => { document.querySelector('#feed').scrollTop = 0; });
    },
  },
  {
    name: 'diff',
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.offByOne);
      await page.waitForSelector('.turncard');
      await page.click('.turncard > summary');
      await page.click('.tool:has(.name:text-is("Edit")) > summary');
      await page.waitForSelector('.diff');
      await page.evaluate(() => {
        const d = document.querySelector('.diff');
        d.scrollIntoView({ block: 'center' });
      });
    },
  },
  {
    name: 'summary',
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.offByOne);
      await page.waitForSelector('.turncard');
      await page.click('.turncard > summary');
      await page.waitForSelector('.receipt-activity');
      await page.waitForTimeout(150); // let the opened disclosure settle before measuring
      await page.evaluate(() => {
        const feed = document.querySelector('#feed');
        const card = document.querySelector('.turncard');
        // Absolute content offset, not the current scrollTop: Playwright's click may
        // already have scrolled the summary under the bar, and the screenshot must
        // land in the same place every run.
        const top = card.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop;
        feed.scrollTop = Math.max(0, top - 56);
      });
    },
  },
  {
    name: 'status',
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.offByOne);
      await page.waitForSelector('.turncard');
      await page.waitForSelector('#subtitle');
      await page.click('#sessionTitleButton');
      await page.waitForSelector('.session-details .status-table');
    },
  },
  {
    // The plan review sheet, opened from the compact card in the dock.
    name: 'plan',
    pending: { plan: true },
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.router);
      await page.waitForSelector('.card.plan');
      await page.click('.card.plan .dec-btn');
      await page.waitForSelector('#sheet:not([hidden]) .plan-doc');
      await page.waitForTimeout(400); // let the sheet finish rising
    },
  },
  {
    // Settings, opened from the gear on the Sessions bar. No tunnel runs in the demo, so the
    // QR row (and with it a real address) never appears.
    name: 'settings',
    async run(page, ctx) {
      await ctx.open('/');
      await page.click('#settingsBtn');
      await page.waitForSelector('#sheet:not([hidden]) .set-group');
      // The notification value fills in once the page has asked the browser.
      await page.waitForFunction(() => [...document.querySelectorAll('#sheet .set-row')].some((r) => /Notifications/.test(r.textContent) && /\S/.test(r.querySelector('.set-val').textContent)));
      await page.waitForTimeout(400); // let the sheet finish rising
    },
  },
  {
    // Settings > Appearance: the seven theme cards, the current one ringed and ticked.
    name: 'appearance',
    async run(page, ctx) {
      await ctx.open('/');
      await page.click('#settingsBtn');
      await page.waitForSelector('#sheet:not([hidden]) .set-group');
      await page.click('#sheet .set-row:has-text("Appearance")');
      await page.waitForSelector('#sheet .theme-grid .theme-card[aria-checked="true"]');
      await page.waitForTimeout(400);
    },
  },
  {
    // The approval card with the whole command, above the composer while the turn waits on it.
    name: 'approval',
    pending: { approval: true },
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.pagination);
      await page.waitForSelector('.card.approval .cmd-text');
      await page.waitForSelector('#working:not([hidden])');
    },
  },
];

// States worth a tap-target audit that are not in the README set (only with --audit).
const AUDIT_SCENES = [
  {
    name: 'audit-menu',
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.offByOne);
      await page.waitForSelector('.turncard');
      await page.click('#menuBtn');
      await page.waitForSelector('#sheet:not([hidden]) .set-group');
    },
  },
  {
    name: 'audit-new',
    async run(page, ctx) {
      await ctx.open('/');
      await page.click('#newBtn');
      await page.waitForSelector('#sheet:not([hidden]) .folder');
    },
  },
  {
    name: 'audit-search',
    async run(page, ctx) {
      await ctx.open('/');
      await page.click('#searchBtn');
      await page.waitForSelector('#searchRow:not([hidden]) #q');
    },
  },
  {
    name: 'audit-plus',
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.offByOne);
      await page.waitForSelector('.turncard');
      await page.click('#attachBtn');
      await page.waitForSelector('#sheet:not([hidden])');
    },
  },
  {
    // A running turn with text in the field: the Queue/Steer segmented and the stop/send morph.
    name: 'audit-composer',
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.toml);
      await page.waitForSelector('#working:not([hidden])');
      await page.fill('#input', 'Also update the changelog');
      await page.waitForSelector('#modeRow:not([hidden]) .seg');
      await page.click('#modeRow .seg [data-value="steer"]');
    },
  },
  {
    name: 'audit-notifications',
    async run(page, ctx) {
      await ctx.open('/');
      await page.click('#settingsBtn');
      await page.waitForSelector('#sheet:not([hidden]) .set-group');
      await page.click('#sheet .set-row:has-text("Notifications")');
      await page.waitForSelector('#sheet input[type="checkbox"]');
    },
  },
];

// Runs in the page. Every control on screen whose tap would not land on it within a 44 by 44
// box around its centre. The box is measured by probing outward from the centre with
// elementFromPoint, so padding and pseudo-element hit boxes count, and an input counts its
// <label>. A control covered at its centre (under a sheet, say) is skipped: it cannot be tapped.
function tapAudit() {
  const SEL = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], [role="link"], [role="menuitem"], [role="option"]';
  const W = innerWidth, H = innerHeight, MIN = 44;
  const short = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    const text = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  };
  // A rough accessible name: aria-label, aria-labelledby, a <label>, the text a screen reader
  // would read (leaving out aria-hidden parts), then title or placeholder.
  const nameOf = (el) => {
    const al = (el.getAttribute('aria-label') || '').trim();
    if (al) return al;
    const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
    if (by) return by;
    if (el.labels && [...el.labels].some((l) => l.textContent.trim())) return 'label';
    const copy = el.cloneNode(true);
    for (const n of copy.querySelectorAll('[aria-hidden="true"]')) n.remove();
    return copy.textContent.trim() || (el.getAttribute('title') || '').trim() || (el.getAttribute('placeholder') || '').trim();
  };
  const fails = [];
  let checked = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (el.tagName === 'A' && el.closest('.md')) continue; // links inside prose are exempt
    if (el.closest('[inert]') || el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (!nameOf(el)) fails.push(`${short(el)}: no accessible name`);
    if (r.left < 0 || r.top < 0 || r.right > W || r.bottom > H) continue; // partly off screen: judged in another scene
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const labels = el.labels ? [...el.labels] : [];
    const owns = (n) => !!n && (n === el || el.contains(n) || labels.some((l) => l === n || l.contains(n)));
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (!owns(document.elementFromPoint(cx, cy))) continue;
    const reach = (dx, dy) => {
      let n = 0;
      for (let i = 1; i <= 40; i++) {
        const x = cx + dx * i, y = cy + dy * i;
        if (x < 0 || y < 0 || x >= W || y >= H || !owns(document.elementFromPoint(x, y))) break;
        n = i;
      }
      return n;
    };
    const w = reach(-1, 0) + reach(1, 0) + 1, h = reach(0, -1) + reach(0, 1) + 1;
    checked++;
    if (w < MIN || h < MIN) fails.push(`${short(el)}: hit ${w}x${h}, ink ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return { checked, fails };
}

// Runs in the page under prefers-reduced-motion: anything that could still move, or any fade
// that is slower than the 120ms the plan allows (the working glyph is the one 3s exception).
function motionAudit() {
  const ALLOWED = new Set(['none', 'spin', 'fade-in', 'fade-out']);
  const out = [];
  const seen = new Set();
  const note = (s) => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  const secs = (s) => (s || '').split(',').map((x) => parseFloat(x) || 0);
  for (const el of document.querySelectorAll('*')) {
    for (const pseudo of [null, '::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      const props = cs.transitionProperty.split(',').map((s) => s.trim());
      const tdurs = secs(cs.transitionDuration);
      props.forEach((p, i) => {
        const ms = (tdurs[i % tdurs.length] || 0) * 1000;
        if ((p === 'transform' || p === 'all' || p === 'translate' || p === 'scale' || p === 'rotate') && ms > 0) note(`${name(el)}${pseudo || ''}: transition on ${p}`);
        if (p !== 'none' && ms > 121) note(`${name(el)}${pseudo || ''}: ${p} transition takes ${Math.round(ms)}ms under Reduce Motion`);
      });
      const anames = cs.animationName.split(',').map((s) => s.trim());
      const adurs = secs(cs.animationDuration);
      anames.forEach((a, i) => {
        if (!ALLOWED.has(a)) note(`${name(el)}${pseudo || ''}: animation ${a}`);
        const ms = (adurs[i % adurs.length] || 0) * 1000;
        if (a === 'spin' && ms < 2999) note(`${name(el)}${pseudo || ''}: working glyph is ${Math.round(ms)}ms, want 3s`);
        if ((a === 'fade-in' || a === 'fade-out') && ms > 121) note(`${name(el)}${pseudo || ''}: ${a} takes ${Math.round(ms)}ms, want 120ms`);
      });
    }
  }
  for (const k of window.__motionLog || []) note(`script animation: ${k}`);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chromium = loadChromium();
  fs.mkdirSync(args.out, { recursive: true });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rc-shots-'));
  const quiet = { log() {}, error: console.error, warn: console.error };

  // Everything started here is stopped in the finally, whichever step fails.
  let mock = null, app = null, browser = null;
  const written = [];
  const problems = [];
  const scenes = SCENES.concat(args.audit ? AUDIT_SCENES : []);
  const keepAuditShots = path.resolve(args.out) !== path.join(ROOT, 'docs', 'screenshots');
  // A check run must not overwrite the committed README set by accident. Only write pictures
  // when --out names where they go (the normal, unflagged run still writes docs/screenshots).
  const writeShots = !(args.audit || args.reducedMotion) || args.outExplicit;
  if (!writeShots) console.log('[check] no --out: checking only, not writing pictures');
  try {
    mock = await startDemoDsh({ now: NOW });
    app = await startServer({ env: {}, stateDir, port: 0, host: '127.0.0.1', dshUrl: mock.url, watch: false, logger: quiet });
    const base = `http://127.0.0.1:${app.port}`;
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox'],
    });
    for (const scene of scenes) {
      if (args.only && !args.only.has(scene.name)) continue;
      mock.setPending({ approval: false, plan: false, ...scene.pending });
      const context = await browser.newContext({
        viewport: { width: args.width, height: HEIGHT },
        deviceScaleFactor: args.scale,
        isMobile: true,
        hasTouch: true,
        colorScheme: args.scheme,
        reducedMotion: args.reducedMotion ? 'reduce' : 'no-preference',
        locale: 'en-US',
        timezoneId: 'UTC',
        serviceWorkers: 'block',
      });
      if (args.reducedMotion) {
        // Log every script animation whose keyframes move something (a transform that changes).
        await context.addInitScript(() => {
          window.__motionLog = [];
          const orig = Element.prototype.animate;
          Element.prototype.animate = function (frames, opts) {
            const list = Array.isArray(frames) ? frames : [];
            const tf = new Set(list.map((f) => (f && f.transform) || 'none'));
            if (tf.size > 1) window.__motionLog.push(`${this.tagName.toLowerCase()}${this.id ? '#' + this.id : ''} ${[...tf].join(' -> ')}`);
            return orig.call(this, frames, opts);
          };
        });
      }
      const errors = [];
      // The saved theme, as public/theme.js reads it before first paint. The default is no entry.
      if (args.theme !== 'default') {
        await context.addInitScript((id) => { try { localStorage.setItem('dsh-rc.theme', id); } catch {} }, args.theme);
      }
      if (scene.storage) {
        await context.addInitScript((entries) => {
          try { for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v); } catch {}
        }, scene.storage(NOW));
      }
      const page = await context.newPage();
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const at = m.location && m.location().url;
        errors.push(m.text() + (at ? ` (${at.replace(/^https?:\/\/[^/]+/, '')})` : ''));
      });
      page.on('pageerror', (err) => errors.push(String(err)));
      // Date.now() stands still at NOW, so "4m 12s" and "23m" read the same on every run.
      await page.clock.setFixedTime(NOW);
      const ctx = {
        async open(route) {
          await page.goto(base + route);
          // app.js marks #app once the live socket is up (the offline banner is down).
          await page.waitForFunction(() => document.querySelector('#app[data-conn="up"]'));
          // Fonts change line boxes and therefore pinned scroll positions. Wait for
          // them before a scene measures or scrolls, not only before the capture.
          await page.evaluate(() => document.fonts.ready);
        },
      };
      await scene.run(page, ctx);
      if (args.reducedMotion) {
        for (const m of await page.evaluate(motionAudit)) problems.push(`${scene.name}: reduced motion: ${m}`);
      }
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      if (args.audit) {
        const { checked, fails } = await page.evaluate(tapAudit);
        console.log(`[audit] ${scene.name}: ${checked} controls on screen, ${fails.length} problems`);
        for (const f of fails) problems.push(`${scene.name}: ${f}`);
      }
      for (const e of errors) problems.push(`${scene.name}: console error: ${e}`);
      if (writeShots && (!scene.name.startsWith('audit-') || keepAuditShots)) {
        const file = path.join(args.out, scene.name + '.png');
        await page.screenshot({ path: file, animations: 'disabled', caret: 'initial' });
        written.push(file);
      }
      await context.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) await app.close().catch(() => {});
    if (mock) await mock.close().catch(() => {});
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  for (const f of written) console.log(`${path.relative(ROOT, f)}  ${(fs.statSync(f).size / 1024).toFixed(0)} KB`);
  for (const p of problems) console.error(`[check] ${p}`);
  if (problems.length && (args.audit || args.reducedMotion)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[screenshots] ${err.message}`);
  process.exit(1);
});
