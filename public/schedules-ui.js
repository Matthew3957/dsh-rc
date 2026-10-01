'use strict';
// The Scheduled prompts sheet (dsh 0.2 and later, with dsh's optional schedule plugin).
// The rules live in schedules.js; this file only draws. It loads after app.js and uses its helpers
// (h, rpc, openSheet, closeSheet, toast, S, TZ, dsh2). Nothing here runs on the older API: the
// menu entry appears only after dsh answered schedule/catalog, so a dsh without the plugin
// (a 404 there) shows nothing at all.

(() => {
  const SC = () => window.dshSchedules;
  const ZONE = () => TZ || 'UTC';
  let available = false;
  let redraw = null; // repaints the open list or detail; null while a form is open, so typing is never lost
  const TITLE = 'Scheduled prompts';

  async function probe() {
    if (!dsh2 || !SC()) { available = false; return; }
    try { await rpc('schedule.catalog', {}); available = true; } catch { available = false; }
  }

  const fmt = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fail = (what, e) => openSheet(h('h3', { 'data-sched': '' }, TITLE), h('div', { class: 'note err' }, `${what}: ${e.message}`));

  async function rows() {
    return SC().sessionSchedules(await rpc('schedule.catalog', {}), S.cur.id);
  }

  async function listSheet(note) {
    if (!S.cur) return;
    const draw = async (msg) => {
      let list;
      try { list = await rows(); } catch (e) { redraw = null; return fail('Could not read the schedules', e); }
      const now = Date.now();
      const item = (e) => {
        const st = SC().stateOf(e, now);
        return h('button', { type: 'button', class: 'plug sched', onclick: () => detailSheet(e.id) },
          h('span', { class: 'pdot ' + (st === 'active' ? 'on' : st === 'overdue' ? 'late' : 'off') }),
          h('div', { class: 'pmain' }, h('b', {}, e.title), h('small', {}, `${SC().ruleText(e, TZ)} · ${SC().nextText(e, now)}`)),
          h('span', { class: 'pstate' }, '›'));
      };
      openSheet(h('h3', { 'data-sched': '' }, TITLE),
        msg ? h('div', { class: 'note' }, msg) : null,
        list.length ? list.map(item) : h('div', { class: 'note' }, 'Nothing is scheduled in this session.'),
        h('button', { type: 'button', class: 'go', onclick: () => formSheet(null) }, 'New scheduled prompt'));
    };
    redraw = () => draw();
    openSheet(h('h3', { 'data-sched': '' }, TITLE), h('div', { class: 'note' }, 'Loading…'));
    await draw(note);
  }

  async function detailSheet(id) {
    const draw = async () => {
      let e;
      try { e = (await rows()).find((r) => r.id === id); } catch (err) { redraw = null; return fail('Could not read the schedule', err); }
      if (!e) return listSheet('That schedule is gone.');
      const now = Date.now();
      const line = (k, v) => h('div', { class: 'sched-kv' }, h('span', {}, k), h('span', {}, v));
      let armed = null; // timer of the armed "tap again" state
      const del = h('button', { type: 'button', class: 'menuitem sched-del' }, 'Delete');
      del.onclick = async () => {
        if (armed === null) {
          del.textContent = 'Tap again to delete'; del.classList.add('armed');
          armed = setTimeout(() => { armed = null; del.textContent = 'Delete'; del.classList.remove('armed'); }, 4000);
          return;
        }
        clearTimeout(armed); del.disabled = true; del.textContent = 'Deleting…';
        try {
          const r = await rpc('schedule.delete', { sessionId: S.cur.id, id: e.id });
          listSheet(r && r.deleted === false ? 'That schedule was already gone.' : 'Deleted.');
        } catch (err) {
          // Back to the unarmed state, so the next tap asks again instead of deleting at once.
          armed = null; del.classList.remove('armed');
          del.disabled = false; del.textContent = 'Delete'; toast('Delete failed: ' + err.message, 4000);
        }
      };
      openSheet(h('h3', { 'data-sched': '' }, e.title),
        h('div', { class: 'note cmd' }, e.prompt),
        line('When', SC().ruleText(e, TZ)),
        line('Next', SC().stateOf(e, now) === 'done' ? 'finished' : `${fmt(e.scheduledAt)} (${SC().nextText(e, now).replace(/^next /, '')})`),
        e.lastDelivery ? line('Last sent', fmt(e.lastDelivery.deliveredAt)) : null,
        e.status === 'inactive' ? null : h('button', { type: 'button', class: 'menuitem', onclick: () => formSheet(e) }, 'Edit'),
        del,
        h('button', { type: 'button', class: 'menuitem', onclick: () => listSheet() }, '‹ All scheduled prompts'));
    };
    redraw = draw;
    await draw();
  }

  const WHEN = [['in', 'In…'], ['at', 'At a date and time'], ['every', 'Every…'], ['daily', 'Every day at'], ['weekly', 'On certain days at']];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function formSheet(entry) {
    redraw = null;
    const cur = S.cur;
    const soon = SC().localParts(new Date(Date.now() + 3600e3));
    const f = { when: entry ? 'keep' : 'in', n: '30', unit: 'min', date: soon.date, time: '09:00', days: [1, 2, 3, 4, 5] };
    const title = h('input', { type: 'text', maxlength: 120, value: entry ? entry.title : '', placeholder: 'A short name' });
    const prompt = h('textarea', { class: 'sched-prompt', rows: 4, placeholder: 'What dsh should be told when it is time' }, entry ? entry.prompt : '');
    const when = h('select', {}, entry ? h('option', { value: 'keep' }, 'Keep: ' + SC().ruleText(entry, TZ)) : null,
      WHEN.map(([v, t]) => h('option', { value: v }, t)));
    when.value = f.when;
    const fields = h('div', { class: 'when-fields' });
    const err = h('div', { class: 'note err', hidden: true });
    const go = h('button', { type: 'button', class: 'go' }, entry ? 'Save changes' : 'Ask dsh to schedule it');

    const num = () => [
      h('input', { type: 'number', inputmode: 'numeric', min: 1, value: f.n, 'aria-label': 'How many', oninput: (ev) => { f.n = ev.target.value; } }),
      (() => { const s = h('select', { 'aria-label': 'Unit', onchange: (ev) => { f.unit = ev.target.value; } }, [['min', 'minutes'], ['h', 'hours'], ['d', 'days']].map(([v, t]) => h('option', { value: v }, t))); s.value = f.unit; return s; })(),
    ];
    const clock = () => h('input', { type: 'time', value: f.time, 'aria-label': 'Time', oninput: (ev) => { f.time = ev.target.value; } });
    const paint = () => {
      const kids = [];
      if (f.when === 'in' || f.when === 'every') kids.push(h('div', { class: 'when-row' }, num()));
      if (f.when === 'at') kids.push(h('div', { class: 'when-row' }, h('input', { type: 'date', value: f.date, 'aria-label': 'Date', oninput: (ev) => { f.date = ev.target.value; } }), clock()));
      if (f.when === 'daily') kids.push(h('div', { class: 'when-row' }, clock()));
      if (f.when === 'weekly') {
        kids.push(h('div', { class: 'when-days' }, DAYS.map((d, i) => {
          const b = h('button', { type: 'button', class: 'chip' + (f.days.includes(i + 1) ? ' on' : ''), 'aria-pressed': String(f.days.includes(i + 1)) }, d);
          b.onclick = () => {
            f.days = f.days.includes(i + 1) ? f.days.filter((x) => x !== i + 1) : [...f.days, i + 1];
            b.classList.toggle('on', f.days.includes(i + 1)); b.setAttribute('aria-pressed', String(f.days.includes(i + 1)));
          };
          return b;
        })), h('div', { class: 'when-row' }, clock()));
      }
      if (f.when !== 'keep') kids.push(h('small', { class: 'sched-zone' }, f.when === 'in' || f.when === 'every' ? '' : `Times are in ${ZONE()}.`));
      fields.replaceChildren(...kids);
    };
    when.onchange = () => { f.when = when.value; paint(); };
    paint();

    const show = (msg) => { err.textContent = msg; err.hidden = false; };
    go.onclick = async () => {
      err.hidden = true;
      const t = title.value.trim(); const p = prompt.value.trim();
      if (!t) return show('Give it a name.');
      if (!p) return show('Say what dsh should be told.');
      let rule = null;
      if (f.when !== 'keep') {
        const r = SC().buildRule(f, ZONE());
        if (!r.ok) return show(r.error);
        rule = r.rule;
      }
      go.disabled = true;
      try {
        if (!entry) {
          await rpc('session.prompt', { sessionId: cur.id, mode: 'queue', content: [{ type: 'text', text: SC().createMessage({ title: t, prompt: p, rule }) }], ...(TZ ? { clientTimeZone: TZ } : {}) });
          closeSheet();
          toast('Asked dsh to schedule it. It shows here once the agent has done it.', 5000);
          return;
        }
        const req = SC().updateRequest(cur.id, entry, { title: t, prompt: p, rule });
        if (!req.title && !req.prompt && !req.change) { go.disabled = false; return show('Nothing has changed.'); }
        const out = SC().updateOutcome(await rpc('schedule.update', req));
        if (out.ok) { toast('Saved'); return detailSheet(entry.id); }
        if (/^schedule_/.test(out.code)) { toast(out.message, 5000); return listSheet(); }
        go.disabled = false; show(out.message);
      } catch (e) { go.disabled = false; show((entry ? 'Could not save: ' : 'Could not send: ') + e.message); }
    };

    openSheet(h('h3', { 'data-sched': '' }, entry ? 'Edit scheduled prompt' : 'New scheduled prompt'),
      entry ? null : h('div', { class: 'note' }, 'dsh has no way to create one from here, so this asks the agent to set it up with its own schedule tool. It costs one short turn.'),
      h('label', {}, 'Name'), title,
      h('label', {}, 'Prompt'), prompt,
      h('label', {}, 'When'), when, fields,
      err, go,
      h('button', { type: 'button', class: 'menuitem', onclick: () => (entry ? detailSheet(entry.id) : listSheet()) }, 'Cancel'));
  }

  window.dshSchedulesUI = {
    probe,
    /** The session menu entry, or null where the schedule plugin is not there. */
    menuItem: () => (available && dsh2 ? h('button', { class: 'menuitem', onclick: () => listSheet() }, TITLE, h('small', {}, 'Prompts dsh sends on a timer')) : null),
    /** `host/schedules-changed`: dsh only says this when the plugin is loaded. */
    changed: () => {
      available = !!dsh2;
      // Only repaint while a schedules sheet is the one on screen, never over another sheet.
      if (redraw && !$('#sheet').hidden && $('#sheetBody [data-sched]')) redraw();
    },
  };
})();
