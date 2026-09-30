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

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'docs', 'screenshots'), scale: 2, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--scale') out.scale = Number(argv[++i]);
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
const SCENES = [
  {
    name: 'sessions',
    async run(page, ctx) {
      await ctx.open('/');
      await page.waitForSelector('#sessions .sess >> nth=7');
      await page.waitForSelector('.run-card .run-more-txt:has-text("subagent")');
    },
  },
  {
    name: 'running',
    async run(page, ctx) {
      await ctx.open('/');
      await page.waitForSelector('.run-card .run-more-txt:has-text("subagent")');
      await page.click(`.run-card[data-session="${ID.pagination}"] .run-more`);
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
      await page.evaluate(() => {
        document.querySelector('.turncard').scrollIntoView({ block: 'center' });
      });
    },
  },
  {
    name: 'status',
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.offByOne);
      await page.waitForSelector('.turncard');
      await page.waitForSelector('#statusBar:not([hidden]) .status-part.model');
      await page.click('#statusLine');
      await page.waitForSelector('.status-table');
    },
  },
  {
    name: 'plan',
    pending: { plan: true },
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.router);
      await page.waitForSelector('.card.plan');
      await page.evaluate(() => { const box = document.querySelector('#pending'); box.scrollTop = box.scrollHeight; });
    },
  },
  {
    name: 'approval',
    pending: { approval: true },
    async run(page, ctx) {
      await ctx.open('/#s/' + ID.pagination);
      await page.waitForSelector('.card.approval');
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
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: args.scale,
        isMobile: true,
        hasTouch: true,
        colorScheme: 'dark',
        locale: 'en-US',
        timezoneId: 'UTC',
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      // Date.now() stands still at NOW, so "4m 12s" and "23m" read the same on every run.
      await page.clock.setFixedTime(NOW);
      const ctx = {
        async open(route) {
          await page.goto(base + route);
          await page.waitForFunction(() => document.querySelector('.conn.on'));
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
