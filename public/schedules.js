// Pure helpers behind the Scheduled prompts sheet (dsh 0.2 and later, with its optional schedule plugin).
//
// From the generated `typert.remote-client.d.ts` and `types/types.d.ts` of dsh-schedule:
//   - schedule/catalog () -> every retained task on the host, each a ScheduleRecord plus `sessionId`,
//     `status` ('active' | 'inactive') and `lastDelivery`. The sheet lists the open session's rows.
//   - schedule/update ({sessionId, id, expected, title?, prompt?, change?}) is compare-and-update:
//     `expected` is the whole record as the page last read it, so an edit made elsewhere answers
//     `schedule_conflict` instead of being overwritten. `change` is a timing selector
//     ({kind: 'at' | 'every' | 'daily' | 'weekly' | 'cron', <kind>: {...}}); a one-shot "in N minutes"
//     has no selector of its own on update, so it is sent as an absolute `at`.
//   - schedule/delete ({sessionId, id}) -> {id, deleted} (deleted false + code when it was already gone).
//   - There is no remote create and no pause: creation is the agent's `schedule_create` tool
//     (ScheduleCreateRequest), so the page asks the agent to call it with exact arguments.
//   - Without the plugin (dsh ships it switched off) every schedule/* endpoint answers 404.

const obj = (v) => (v && typeof v === 'object' ? v : {});
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const UNIT_SECONDS = { min: 60, h: 3600, d: 86400 };

/** The session's tasks from a schedule/catalog value: active first, then by next target. */
export function sessionSchedules(catalog, sessionId) {
  const rows = (Array.isArray(catalog) ? catalog : []).filter((e) => e && e.sessionId === sessionId && e.id);
  const rank = (e) => (e.status === 'inactive' ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
}

/** 'active' | 'overdue' (target passed, not yet delivered) | 'done' (will not fire again). */
export function stateOf(entry, now = Date.now()) {
  if (obj(entry).status === 'inactive') return 'done';
  return Date.parse(entry.scheduledAt) < now ? 'overdue' : 'active';
}

/** `in 2h 10m`, `in 3d`, `in under a minute`. */
export function inText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function every(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400} d`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** How often it fires, in a few words. `localZone` hides the zone when it is the viewer's own. */
export function ruleText(entry, localZone) {
  const e = obj(entry);
  const zone = e.timeZone && e.timeZone !== localZone ? ` (${e.timeZone})` : '';
  const hm = typeof e.time === 'string' ? e.time.slice(0, 5) : '';
  switch (e.kind) {
    case 'every': return `every ${every(e.everySeconds)}`;
    case 'daily': return `daily at ${hm}${zone}`;
    case 'weekly': return `${(e.weekdays || []).map((d) => DAYS[d - 1]).join(', ')} at ${hm}${zone}`;
    case 'cron': return `cron ${e.expression}${zone}`;
    default: return 'once';
  }
}

/** The next target as one line: `in 2h 10m`, `overdue`, or `finished`. */
export function nextText(entry, now = Date.now()) {
  const s = stateOf(entry, now);
  if (s === 'done') return 'finished';
  if (s === 'overdue') return 'overdue, waiting for the session';
  return 'next in ' + inText(Date.parse(entry.scheduledAt) - now);
}

/** Drop the catalog-only fields: `expected` of an update is the bare record. */
export function expectedOf(entry) {
  const { sessionId, status, lastDelivery, ...record } = obj(entry);
  return record;
}

/**
 * The "when" part of the form as the agent's selector, or an error sentence.
 * @param f {when: 'in'|'at'|'every'|'daily'|'weekly', n, unit, date, time, days: number[]}
 * @param zone explicit IANA zone the wall-clock kinds are read in
 */
export function buildRule(f, zone, now = Date.now()) {
  const x = obj(f);
  const seconds = () => {
    const n = Number(x.n);
    if (!Number.isInteger(n) || n < 1 || !UNIT_SECONDS[x.unit]) return null;
    return n * UNIT_SECONDS[x.unit];
  };
  const clock = () => (/^\d{2}:\d{2}(:\d{2})?$/.test(x.time || '') ? (x.time.length === 5 ? x.time + ':00' : x.time) : null);
  switch (x.when) {
    case 'in': {
      const s = seconds();
      return s ? { ok: true, rule: { after_seconds: s } } : { ok: false, error: 'Give a whole number of minutes, hours or days.' };
    }
    case 'every': {
      const s = seconds();
      if (!s) return { ok: false, error: 'Give a whole number of minutes, hours or days.' };
      return s < 60 ? { ok: false, error: 'The shortest interval is one minute.' } : { ok: true, rule: { every_seconds: s } };
    }
    case 'at': {
      const t = clock();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date || '') || !t) return { ok: false, error: 'Pick a date and a time.' };
      // The page's own zone is the one the form is read in, so this check is exact there.
      if (Date.parse(`${x.date}T${t}`) <= now) return { ok: false, error: 'That time has already passed.' };
      return { ok: true, rule: { at: { date: x.date, time: t, time_zone: zone } } };
    }
    case 'daily': {
      const t = clock();
      return t ? { ok: true, rule: { daily: { time: t, time_zone: zone } } } : { ok: false, error: 'Pick a time.' };
    }
    case 'weekly': {
      const t = clock();
      const days = [...new Set((x.days || []).map(Number))].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
      if (!t) return { ok: false, error: 'Pick a time.' };
      if (!days.length) return { ok: false, error: 'Pick at least one day.' };
      return { ok: true, rule: { weekly: { time: t, time_zone: zone, weekdays: days } } };
    }
    default: return { ok: false, error: 'Pick when it should run.' };
  }
}

/** A selector from buildRule as the `change` of an update. */
export function changeOf(rule, now = Date.now()) {
  if (rule.after_seconds) return { kind: 'at', at: new Date(now + rule.after_seconds * 1000).toISOString() };
  if (rule.at) return { kind: 'at', at: rule.at };
  if (rule.every_seconds) return { kind: 'every', every_seconds: rule.every_seconds };
  if (rule.daily) return { kind: 'daily', daily: rule.daily };
  return { kind: 'weekly', weekly: rule.weekly };
}

/** The update request for one edit; only what changed is sent besides the record it was based on. */
export function updateRequest(sessionId, entry, edit, now = Date.now()) {
  const req = { sessionId, id: entry.id, expected: expectedOf(entry) };
  if (edit.title != null && edit.title.trim() !== entry.title) req.title = edit.title.trim();
  if (edit.prompt != null && edit.prompt.trim() !== entry.prompt) req.prompt = edit.prompt.trim();
  if (edit.rule) req.change = changeOf(edit.rule, now);
  return req;
}

/** The message that asks the agent to create a task: dsh has no remote create. */
export function createMessage({ title, prompt, rule }) {
  return 'Please schedule this for the current session with your schedule_create tool, using exactly these arguments. '
    + 'Do not do the task now. Reply with one short line saying it is scheduled.\n'
    + JSON.stringify({ title: title.trim(), prompt: prompt.trim(), ...rule });
}

const MISS = {
  schedule_conflict: 'It changed somewhere else since you opened it. The latest version is shown.',
  schedule_ended: 'That schedule has already finished.',
  schedule_not_found: 'That schedule no longer exists.',
};

/** An update value as {ok, record} or {ok: false, message}; tool errors arrive as values with a `code`. */
export function updateOutcome(v) {
  const r = obj(v);
  if (r.record) return { ok: true, record: r.record };
  return { ok: false, code: r.code, message: MISS[r.code] || r.message || 'dsh refused the change.' };
}

/** The local `YYYY-MM-DD` and `HH:mm` of an instant, for filling the form. */
export function localParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

// app.js is a classic script and cannot import this module. Absent in Node, where the tests import it.
if (typeof window !== 'undefined') {
  window.dshSchedules = { sessionSchedules, stateOf, inText, ruleText, nextText, expectedOf, buildRule, changeOf, updateRequest, createMessage, updateOutcome, localParts };
}
