'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLayout, validateSchedule } = require('../src/schedule');
const { startServer } = require('../testlib/helpers');

const TZ = 'America/Barbados'; // UTC-4, no DST
const at = (iso) => new Date(iso);
const sched = (o) => ({ id: 1, layout_id: 10, priority: 0, days_mask: 127, start_time: null, end_time: null, start_date: null, end_date: null, enabled: 1, ...o });

test('resolveLayout: default, time windows, overnight, weekdays, dates, priority', () => {
  const p = (schedules) => ({ default_layout_id: 1, schedules });
  assert.equal(resolveLayout(p([]), at('2026-10-28T12:00:00Z'), TZ), 1);
  assert.equal(resolveLayout({ default_layout_id: null, schedules: [] }, new Date(), TZ), null);
  // 2026-10-28 is a Wednesday; 12:00Z = 08:00 local
  const breakfast = sched({ start_time: '07:00', end_time: '10:30' });
  assert.equal(resolveLayout(p([breakfast]), at('2026-10-28T12:00:00Z'), TZ), 10);
  assert.equal(resolveLayout(p([breakfast]), at('2026-10-28T14:30:00Z'), TZ), 1, 'end is exclusive');
  assert.equal(resolveLayout(p([breakfast]), at('2026-10-28T10:59:00Z'), TZ), 1, 'before start');
  // overnight 22:00 → 06:00
  const night = sched({ start_time: '22:00', end_time: '06:00' });
  assert.equal(resolveLayout(p([night]), at('2026-10-29T03:00:00Z'), TZ), 10, '23:00 local');
  assert.equal(resolveLayout(p([night]), at('2026-10-29T09:30:00Z'), TZ), 10, '05:30 local');
  assert.equal(resolveLayout(p([night]), at('2026-10-29T10:30:00Z'), TZ), 1, '06:30 local');
  // weekdays only (Mon–Fri = bits 1..5 = 62); Saturday 2026-10-31
  const wk = sched({ days_mask: 62 });
  assert.equal(resolveLayout(p([wk]), at('2026-10-28T12:00:00Z'), TZ), 10);
  assert.equal(resolveLayout(p([wk]), at('2026-10-31T12:00:00Z'), TZ), 1);
  // Friday-night overnight window still applies at 02:00 Saturday
  const fri = sched({ days_mask: 1 << 5, start_time: '22:00', end_time: '04:00' });
  assert.equal(resolveLayout(p([fri]), at('2026-10-31T06:00:00Z'), TZ), 10, '02:00 Saturday local');
  assert.equal(resolveLayout(p([fri]), at('2026-11-01T06:00:00Z'), TZ), 1, '02:00 Sunday local');
  // date range, local dates (23:30 local on the 31st is already Nov 1 in UTC)
  const xmas = sched({ start_date: '2026-10-31', end_date: '2026-10-31' });
  assert.equal(resolveLayout(p([xmas]), at('2026-11-01T03:30:00Z'), TZ), 10);
  assert.equal(resolveLayout(p([xmas]), at('2026-11-01T04:30:00Z'), TZ), 1);
  // priority wins, then lower id; disabled ignored
  const lo = sched({ id: 1, layout_id: 10, priority: 0 }), hi = sched({ id: 2, layout_id: 20, priority: 5 }), off = sched({ id: 3, layout_id: 30, priority: 9, enabled: 0 });
  assert.equal(resolveLayout(p([lo, hi, off]), new Date(), TZ), 20);
  assert.equal(resolveLayout(p([sched({ id: 5, layout_id: 50 }), sched({ id: 4, layout_id: 40 })]), new Date(), TZ), 40);
});

test('validateSchedule', () => {
  assert.deepEqual(validateSchedule({ layout_id: 3 }).errors, []);
  assert.equal(validateSchedule({ layout_id: 3 }).schedule.days_mask, 127);
  assert.ok(validateSchedule({}).errors.includes('layout_id required'));
  assert.ok(validateSchedule({ layout_id: 1, start_time: '7am' }).errors.some((e) => /HH:MM/.test(e)));
  assert.ok(validateSchedule({ layout_id: 1, start_time: '07:00' }).errors.some((e) => /go together/.test(e)));
  assert.ok(validateSchedule({ layout_id: 1, days_mask: 200 }).errors.some((e) => /0\.\.127/.test(e)));
  assert.ok(validateSchedule({ layout_id: 1, start_date: '2026-12-01', end_date: '2026-11-01' }).errors.some((e) => /before/.test(e)));
});

test('schedule API drives the manifest', async (t) => {
  const clock = { now: new Date('2026-10-28T12:00:00Z') };
  const s = await startServer({ now: () => clock.now }); t.after(s.close);
  const site = s.addSite('A', 'a');
  const root = await s.login();
  const mk = async (name) => (await s.call('POST', `/api/admin/sites/${site}/layouts`, { cookie: root.cookie, body: { name, template: 'lobby' } })).json.id;
  const def = await mk('Default'), brk = await mk('Breakfast');
  const p = (await s.call('POST', `/api/admin/sites/${site}/players`, { cookie: root.cookie, body: { name: 'p' } })).json;
  await s.call('PATCH', `/api/admin/sites/${site}/players/${p.id}`, { cookie: root.cookie, body: { default_layout_id: def } });
  const bad = await s.call('POST', `/api/admin/sites/${site}/players/${p.id}/schedules`, { cookie: root.cookie, body: { layout_id: 9999 } });
  assert.equal(bad.status, 400);
  const sc = await s.call('POST', `/api/admin/sites/${site}/players/${p.id}/schedules`, { cookie: root.cookie, body: { layout_id: brk, start_time: '07:00', end_time: '10:30', priority: 1 } });
  assert.equal(sc.status, 201);
  const auth = { Authorization: `Bearer ${p.key}` };
  const m = await s.call('GET', '/api/player/manifest', { headers: auth });
  assert.equal(m.json.current_layout_id, brk, '08:00 local → breakfast');
  assert.deepEqual(m.json.layouts.map((l) => l.id).sort(), [def, brk].sort());
  assert.equal(m.json.schedule[0].start_time, '07:00');
  clock.now = new Date('2026-10-28T16:00:00Z');
  const m2 = await s.call('GET', '/api/player/manifest', { headers: { ...auth, 'If-None-Match': m.headers.etag } });
  assert.equal(m2.status, 304, 'the time of day does not change the ETag');
  assert.equal((await s.call('GET', '/api/player/manifest', { headers: auth })).json.current_layout_id, def);
  // deleting a layout in use is refused; disabling the schedule then deleting works
  assert.equal((await s.call('DELETE', `/api/admin/sites/${site}/layouts/${brk}`, { cookie: root.cookie })).status, 409);
  assert.equal((await s.call('PUT', `/api/admin/sites/${site}/players/${p.id}/schedules/${sc.json.id}`, { cookie: root.cookie, body: { enabled: false } })).json.enabled, false);
  assert.equal((await s.call('DELETE', `/api/admin/sites/${site}/players/${p.id}/schedules/${sc.json.id}`, { cookie: root.cookie })).status, 200);
  assert.equal((await s.call('DELETE', `/api/admin/sites/${site}/layouts/${brk}`, { cookie: root.cookie })).status, 200);
});
