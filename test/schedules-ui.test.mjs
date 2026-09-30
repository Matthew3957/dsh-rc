import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as SC from '../public/schedules.js';

// schedules-ui.js is a classic script that uses app.js's helpers. Run it against a stub of them and
// a tiny DOM, so the flows (list, detail, two-tap delete, create, edit conflict) run for real.
class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.hidden = false; this.disabled = false; this._value = undefined; this.className = ''; }
  get classList() { const s = this; return { add: (c) => { s.className = (s.className + ' ' + c).trim(); }, remove: (c) => { s.className = s.className.split(' ').filter((x) => x !== c).join(' '); }, toggle: (c, on) => (on ? this.classList.add(c) : this.classList.remove(c)) }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { this.on[t] = f; }
  append(...k) { this.kids.push(...k); }
  replaceChildren(...k) { this.kids = k; }
  get textContent() { return this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); }
  set textContent(v) { this.kids = [String(v)]; }
  get value() { return this._value !== undefined ? this._value : this.attrs.value !== undefined ? this.attrs.value : this.tag === 'textarea' ? this.textContent : this.tag === 'select' ? this.attrs.value ?? '' : ''; }
  set value(v) { this._value = String(v); }
  set onclick(f) { this.on.click = f; }
  set onchange(f) { this.on.change = f; }
  click() { if (this.on.click) return this.on.click({ target: this }); }
}
function h(tag, attrs = {}, ...kids) {
  const el = new El(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(typeof kid === 'object' ? kid : String(kid));
  return el;
}
const walk = (el, out = []) => { if (typeof el === 'string') return out; out.push(el); el.kids.forEach((k) => walk(k, out)); return out; };
const tick = () => new Promise((r) => setImmediate(r));

function page({ catalog = [], dsh2 = {}, rpcImpl } = {}) {
  const calls = []; const toasts = []; let sheet = [];
  const rpc = async (method, payload) => {
    calls.push(JSON.parse(JSON.stringify([method, payload ?? null])));
    if (rpcImpl) { const r = rpcImpl(method, payload); if (r !== undefined) return r; }
    if (method === 'schedule.catalog') return catalog;
    return {};
  };
  const ctx = vm.createContext({
    window: { dshSchedules: SC }, h, rpc, dsh2, S: { cur: { id: 's1' } }, TZ: 'UTC', toast: (m) => toasts.push(m),
    openSheet: (...k) => { sheet = k.flat().filter((x) => x != null && x !== false); },
    closeSheet: () => { sheet = []; }, $: () => ({ hidden: false }), setTimeout: () => 1, clearTimeout() {}, Date, Promise,
  });
  vm.runInContext(fs.readFileSync(new URL('../public/schedules-ui.js', import.meta.url), 'utf8'), ctx);
  const ui = ctx.window.dshSchedulesUI;
  const all = () => sheet.flatMap((k) => walk(k));
  const text = () => sheet.map((k) => (typeof k === 'string' ? k : k.textContent)).join(' | ');
  const find = (tag, label) => all().find((e) => e.tag === tag && e.textContent.includes(label));
  return { ui, calls, toasts, all, text, find, sheet: () => sheet, ctx };
}

const soon = (ms) => new Date(Date.now() + ms).toISOString();
const row = (o) => ({ id: 'schedule-1', kind: 'daily', title: 'Morning check', prompt: 'Check CI', time: '09:30:00.000', timeZone: 'UTC', scheduledAt: soon(3600e3), sessionId: 's1', status: 'active', ...o });

test('the menu entry exists only once dsh answered schedule/catalog', async () => {
  const ok = page();
  assert.equal(ok.ui.menuItem(), null, 'hidden until probed');
  await ok.ui.probe();
  assert.match(ok.ui.menuItem().textContent, /Scheduled prompts/);

  const noPlugin = page({ rpcImpl: (m) => { if (m === 'schedule.catalog') throw Object.assign(new Error('HTTP 404'), { code: 'http-404' }); } });
  await noPlugin.ui.probe();
  assert.equal(noPlugin.ui.menuItem(), null);

  const older = page({ dsh2: null });
  await older.ui.probe();
  assert.equal(older.ui.menuItem(), null);
  assert.deepEqual(older.calls, [], 'the older API is never asked');
});

test('lists this session\'s schedules, opens one, and deleting takes two taps', async () => {
  const p = page({ catalog: [row({}), row({ id: 'schedule-2', title: 'Elsewhere', sessionId: 's2' })] });
  await p.ui.probe();
  p.ui.menuItem().click(); await tick();
  assert.match(p.text(), /Morning check/);
  assert.doesNotMatch(p.text(), /Elsewhere/);
  assert.match(p.text(), /daily at 09:30 · next in 1h/);
  p.find('button', 'Morning check').click(); await tick();
  assert.match(p.text(), /Check CI/);
  const del = p.find('button', 'Delete');
  del.click();
  assert.equal(del.textContent, 'Tap again to delete');
  assert.ok(!p.calls.some(([m]) => m === 'schedule.delete'));
  await del.click(); await tick();
  assert.deepEqual(p.calls.find(([m]) => m === 'schedule.delete'), ['schedule.delete', { sessionId: 's1', id: 'schedule-1' }]);
  assert.match(p.text(), /Deleted/);
});

test('an empty session says so and offers to add one', async () => {
  const p = page();
  await p.ui.probe();
  p.ui.menuItem().click(); await tick();
  assert.match(p.text(), /Nothing is scheduled/);
  assert.ok(p.find('button', 'New scheduled prompt'));
});

test('creating asks the agent with exact arguments, and checks the form first', async () => {
  const p = page();
  await p.ui.probe();
  p.ui.menuItem().click(); await tick();
  p.find('button', 'New scheduled prompt').click();
  p.find('button', 'Ask dsh to schedule it').click(); await tick();
  assert.match(p.text(), /Give it a name/);
  assert.ok(!p.calls.some(([m]) => m === 'session.prompt'));
  const [title] = p.all().filter((e) => e.tag === 'input' && e.attrs.type === 'text');
  title.value = 'Nightly tidy';
  p.all().find((e) => e.tag === 'textarea').value = 'Tidy the TODO list';
  p.find('button', 'Ask dsh to schedule it').click(); await tick();
  const [, payload] = p.calls.find(([m]) => m === 'session.prompt');
  assert.equal(payload.sessionId, 's1'); assert.equal(payload.mode, 'queue'); assert.equal(payload.clientTimeZone, 'UTC');
  const text = payload.content[0].text;
  assert.match(text, /schedule_create/);
  assert.deepEqual(JSON.parse(text.slice(text.indexOf('{'))), { title: 'Nightly tidy', prompt: 'Tidy the TODO list', after_seconds: 1800 });
  assert.match(p.toasts.join(), /Asked dsh to schedule it/);
});

test('an edit made elsewhere in the meantime is reported and the list reloads', async () => {
  const p = page({ catalog: [row({})], rpcImpl: (m) => (m === 'schedule.update' ? { id: 'schedule-1', updated: false, code: 'schedule_conflict' } : undefined) });
  await p.ui.probe();
  p.ui.menuItem().click(); await tick();
  p.find('button', 'Morning check').click(); await tick();
  p.find('button', 'Edit').click();
  p.all().find((e) => e.tag === 'textarea').value = 'Check CI and lint';
  p.find('button', 'Save changes').click(); await tick(); await tick();
  const [, req] = p.calls.find(([m]) => m === 'schedule.update');
  assert.equal(req.prompt, 'Check CI and lint'); assert.equal(req.change, undefined); assert.equal(req.expected.id, 'schedule-1');
  assert.match(p.toasts.join(), /changed somewhere else/);
  assert.match(p.text(), /Scheduled prompts/);
});

test('saving with nothing changed does not call dsh', async () => {
  const p = page({ catalog: [row({})] });
  await p.ui.probe();
  p.ui.menuItem().click(); await tick();
  p.find('button', 'Morning check').click(); await tick();
  p.find('button', 'Edit').click();
  p.find('button', 'Save changes').click(); await tick();
  assert.match(p.text(), /Nothing has changed/);
  assert.ok(!p.calls.some(([m]) => m === 'schedule.update'));
});
