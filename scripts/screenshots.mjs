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
  const out = { out: path.join(ROOT, 'docs', 'screenshots'), scale: 2, only: null, scheme: 'dark', theme: 'default', width: WIDTH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
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
      const known = new Set(SCENES.map((s) => s.name));
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chromium = loadChromium();
  fs.mkdirSync(args.out, { recursive: true });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rc-shots-'));
  const quiet = { log() {}, error: console.error, warn: console.error };

  // Everything started here is stopped in the finally, whichever step fails.
  let mock = null, app = null, browser = null;
  const written = [];
  try {
    mock = await startDemoDsh({ now: NOW });
    app = await startServer({ env: {}, stateDir, port: 0, host: '127.0.0.1', dshUrl: mock.url, watch: false, logger: quiet });
    const base = `http://127.0.0.1:${app.port}`;
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox'],
    });
    for (const scene of SCENES) {
      if (args.only && !args.only.has(scene.name)) continue;
      mock.setPending({ approval: false, plan: false, ...scene.pending });
      const context = await browser.newContext({
        viewport: { width: args.width, height: HEIGHT },
        deviceScaleFactor: args.scale,
        isMobile: true,
        hasTouch: true,
        colorScheme: args.scheme,
        locale: 'en-US',
        timezoneId: 'UTC',
        serviceWorkers: 'block',
      });
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
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      const file = path.join(args.out, scene.name + '.png');
      await page.screenshot({ path: file, animations: 'disabled', caret: 'initial' });
      written.push(file);
      await context.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) await app.close().catch(() => {});
    if (mock) await mock.close().catch(() => {});
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  for (const f of written) console.log(`${path.relative(ROOT, f)}  ${(fs.statSync(f).size / 1024).toFixed(0)} KB`);
}

main().catch((err) => {
  console.error(`[screenshots] ${err.message}`);
  process.exit(1);
});
