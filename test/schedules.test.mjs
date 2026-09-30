import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRule, changeOf, createMessage, expectedOf, inText, localParts, nextText, ruleText, sessionSchedules, stateOf, updateOutcome, updateRequest,
} from '../public/schedules.js';
import { createClient, fromEvents } from '../public/dsh02.js';

const NOW = Date.UTC(2026, 0, 15, 14, 30);
const at = (ms) => new Date(NOW + ms).toISOString();
const entry = (o) => ({ id: 'schedule-1', kind: 'at', title: 'T', prompt: 'P', scheduledAt: at(3600e3), sessionId: 's1', status: 'active', ...o });

test('the session sheet lists its own tasks, active first then by next target', () => {
  const rows = sessionSchedules([
    entry({ id: 'a', scheduledAt: at(7200e3) }),
    entry({ id: 'done', status: 'inactive', scheduledAt: at(-3600e3) }),
    entry({ id: 'other', sessionId: 's2' }),
    entry({ id: 'b', scheduledAt: at(60e3) }),
  ], 's1');
  assert.deepEqual(rows.map((r) => r.id), ['b', 'a', 'done']);
  assert.deepEqual(sessionSchedules(null, 's1'), []);
});

test('state and next-run text', () => {
  assert.equal(stateOf(entry({}), NOW), 'active');
  assert.equal(stateOf(entry({ scheduledAt: at(-1) }), NOW), 'overdue');
  assert.equal(stateOf(entry({ status: 'inactive' }), NOW), 'done');
  assert.equal(nextText(entry({}), NOW), 'next in 1h');
  assert.equal(nextText(entry({ status: 'inactive' }), NOW), 'finished');
  assert.match(nextText(entry({ scheduledAt: at(-5) }), NOW), /^overdue/);
  assert.equal(inText(20e3), 'under a minute');
  assert.equal(inText(90 * 60e3), '1h 30m');
  assert.equal(inText(5 * 86400e3), '5d');
});

test('ruleText names every kind and hides the viewer\'s own zone', () => {
  assert.equal(ruleText(entry({ kind: 'after' }), 'UTC'), 'once');
  assert.equal(ruleText(entry({ kind: 'every', everySeconds: 7200 }), 'UTC'), 'every 2 h');
  assert.equal(ruleText(entry({ kind: 'every', everySeconds: 90 }), 'UTC'), 'every 90 s');
  assert.equal(ruleText(entry({ kind: 'daily', time: '09:30:00.000', timeZone: 'UTC' }), 'UTC'), 'daily at 09:30');
  assert.equal(ruleText(entry({ kind: 'daily', time: '09:30:00.000', timeZone: 'Europe/Paris' }), 'UTC'), 'daily at 09:30 (Europe/Paris)');
  assert.equal(ruleText(entry({ kind: 'weekly', time: '08:00:00.000', timeZone: 'UTC', weekdays: [1, 3] }), 'UTC'), 'Mon, Wed at 08:00');
  assert.equal(ruleText(entry({ kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'UTC' }), 'UTC'), 'cron 0 9 * * 1-5');
});

test('buildRule makes the create tool\'s selectors and refuses bad input in plain words', () => {
  assert.deepEqual(buildRule({ when: 'in', n: '2', unit: 'h' }, 'UTC', NOW), { ok: true, rule: { after_seconds: 7200 } });
  assert.deepEqual(buildRule({ when: 'every', n: '15', unit: 'min' }, 'UTC', NOW), { ok: true, rule: { every_seconds: 900 } });
  assert.deepEqual(buildRule({ when: 'daily', time: '09:30' }, 'Europe/Paris', NOW).rule, { daily: { time: '09:30:00', time_zone: 'Europe/Paris' } });
  assert.deepEqual(buildRule({ when: 'weekly', time: '08:00', days: ['5', 1, 1] }, 'UTC', NOW).rule, { weekly: { time: '08:00:00', time_zone: 'UTC', weekdays: [1, 5] } });
  assert.equal(buildRule({ when: 'in', n: '0', unit: 'min' }, 'UTC', NOW).ok, false);
  assert.equal(buildRule({ when: 'in', n: '1.5', unit: 'min' }, 'UTC', NOW).ok, false);
  assert.equal(buildRule({ when: 'every', n: '30', unit: 'min' }, 'UTC', NOW).ok, true);
  assert.equal(buildRule({ when: 'weekly', time: '08:00', days: [] }, 'UTC', NOW).ok, false);
  assert.equal(buildRule({ when: 'daily', time: '' }, 'UTC', NOW).ok, false);
  assert.equal(buildRule({ when: 'nope' }, 'UTC', NOW).ok, false);
  const past = buildRule({ when: 'at', date: '2020-01-15', time: '13:00' }, 'UTC', NOW);
  assert.match(past.error, /passed/);
  assert.deepEqual(buildRule({ when: 'at', date: '2099-01-16', time: '13:00' }, 'UTC', NOW).rule, { at: { date: '2099-01-16', time: '13:00:00', time_zone: 'UTC' } });
});

test('an update sends the bare record as `expected` and only what changed', () => {
  const e = entry({ lastDelivery: { scheduledAt: 'x', deliveredAt: 'y', messageId: 'm' } });
  assert.deepEqual(expectedOf(e), { id: 'schedule-1', kind: 'at', title: 'T', prompt: 'P', scheduledAt: e.scheduledAt });
  assert.deepEqual(updateRequest('s1', e, { title: ' T ', prompt: 'P', rule: null }, NOW), { sessionId: 's1', id: 'schedule-1', expected: expectedOf(e) });
  const r = updateRequest('s1', e, { title: 'New', prompt: 'Q', rule: { every_seconds: 600 } }, NOW);
  assert.equal(r.title, 'New'); assert.equal(r.prompt, 'Q');
  assert.deepEqual(r.change, { kind: 'every', every_seconds: 600 });
});

test('a one-shot delay has no update selector, so it becomes an absolute time', () => {
  assert.deepEqual(changeOf({ after_seconds: 600 }, NOW), { kind: 'at', at: at(600e3) });
  assert.deepEqual(changeOf({ at: { date: 'd', time: 't', time_zone: 'z' } }), { kind: 'at', at: { date: 'd', time: 't', time_zone: 'z' } });
  assert.deepEqual(changeOf({ daily: { time: 't', time_zone: 'z' } }), { kind: 'daily', daily: { time: 't', time_zone: 'z' } });
  assert.deepEqual(changeOf({ weekly: { time: 't', time_zone: 'z', weekdays: [1] } }).kind, 'weekly');
});

test('update results become one outcome, conflicts included', () => {
  assert.deepEqual(updateOutcome({ id: 'x', updated: true, record: { id: 'x' } }), { ok: true, record: { id: 'x' } });
  assert.match(updateOutcome({ id: 'x', updated: false, code: 'schedule_conflict' }).message, /changed somewhere else/);
  assert.equal(updateOutcome({ id: 'x', updated: false, code: 'schedule_ended' }).code, 'schedule_ended');
  assert.equal(updateOutcome({ code: 'invalid_prompt', message: 'title must be at most 120 characters.' }).message, 'title must be at most 120 characters.');
  assert.equal(updateOutcome(null).ok, false);
});

test('the create message carries exact, escaped tool arguments', () => {
  const msg = createMessage({ title: ' Tidy ', prompt: 'Say "hi"\nthen stop', rule: { after_seconds: 60 } });
  assert.match(msg, /schedule_create/);
  assert.deepEqual(JSON.parse(msg.slice(msg.indexOf('{'))), { title: 'Tidy', prompt: 'Say "hi"\nthen stop', after_seconds: 60 });
});

test('localParts reads an instant in the viewer\'s zone', () => {
  const { date, time } = localParts(new Date(2026, 5, 2, 7, 5).toISOString());
  assert.equal(date, '2026-06-02'); assert.equal(time, '07:05');
  assert.deepEqual(localParts('nope'), { date: '', time: '' });
});

test('dsh 0.2 adapter: schedule calls use dsh-schedule\'s argument names', async () => {
  const seen = [];
  const transport = async (endpoint, payload) => { seen.push([endpoint, payload]); return []; };
  const c = createClient({ transport, wsUrl: 'ws://x', onFrame() {} });
  assert.ok(c.has('schedule.catalog') && c.has('schedule.update') && c.has('schedule.delete'));
  await c.rpc('schedule.catalog', {});
  await c.rpc('schedule.update', { sessionId: 's', id: 'i', expected: { id: 'i' }, title: 't' });
  await c.rpc('schedule.delete', { sessionId: 's', id: 'i', junk: 1 });
  assert.deepEqual(seen, [
    ['schedule/catalog', { args: {} }],
    ['schedule/update', { args: { request: { sessionId: 's', id: 'i', expected: { id: 'i' }, title: 't' } } }],
    ['schedule/delete', { args: { request: { sessionId: 's', id: 'i' } } }],
  ]);
});

test('a dsh without the plugin answers 404, which reaches the page as an error it can swallow', async () => {
  const transport = async () => { throw Object.assign(new Error('schedule/catalog: HTTP 404'), { code: 'http-404' }); };
  const c = createClient({ transport, wsUrl: 'ws://x', onFrame() {} });
  await assert.rejects(c.rpc('schedule.catalog', {}), { code: 'http-404' });
});

test('schedule/changed becomes a host frame and nothing else', () => {
  assert.deepEqual(fromEvents({ type: 'emit', event: 'schedule/changed', args: [] }), [{ kind: 'host', payload: { type: 'host/schedules-changed' } }]);
});
