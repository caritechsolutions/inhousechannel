'use strict';
// Schedule resolution: which layout a player shows at a moment, in the site's timezone. The
// same rules run on the player (Python) against the manifest, so keep them simple:
//   enabled, date range inclusive (local dates), weekday in days_mask (bit 0 = Sunday),
//   time window [start_time, end_time) with end < start meaning overnight; NULL = no limit.
// Highest priority wins, then the lowest id. Falls back to default_layout_id, then null.

const fmtCache = new Map();
function partsIn(now, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }); }
    catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }); }
    fmtCache.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(now)) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: wd };
}
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function matches(s, local) {
  if (!s.enabled && s.enabled !== undefined) return false;
  if (s.start_date && local.date < s.start_date) return false;
  if (s.end_date && local.date > s.end_date) return false;
  const mask = s.days_mask == null ? 127 : Number(s.days_mask);
  const st = toMinutes(s.start_time), en = toMinutes(s.end_time);
  // An overnight window that started yesterday belongs to yesterday's weekday.
  let weekday = local.weekday;
  if (st != null && en != null && en < st && local.minutes < en) weekday = (weekday + 6) % 7;
  if (!(mask & (1 << weekday))) return false;
  if (st == null || en == null) return true;
  if (st === en) return true;
  return st < en ? local.minutes >= st && local.minutes < en : local.minutes >= st || local.minutes < en;
}

// player: { default_layout_id, schedules: [rows] }. Returns a layout id or null.
function resolveLayout(player, now = new Date(), tz = 'UTC') {
  const local = partsIn(now, tz);
  const hit = (player.schedules || []).filter((s) => matches(s, local))
    .sort((a, b) => (Number(b.priority) - Number(a.priority)) || (Number(a.id) - Number(b.id)))[0];
  if (hit) return hit.layout_id;
  return player.default_layout_id || null;
}

function validateSchedule(b) {
  const errors = [];
  const out = {};
  out.layout_id = Number(b.layout_id);
  if (!Number.isInteger(out.layout_id) || out.layout_id <= 0) errors.push('layout_id required');
  out.priority = b.priority == null ? 0 : Number(b.priority);
  if (!Number.isInteger(out.priority)) errors.push('priority must be an integer');
  out.days_mask = b.days_mask == null ? 127 : Number(b.days_mask);
  if (!Number.isInteger(out.days_mask) || out.days_mask < 0 || out.days_mask > 127) errors.push('days_mask must be 0..127');
  for (const k of ['start_time', 'end_time']) {
    out[k] = b[k] == null || b[k] === '' ? null : String(b[k]).trim();
    if (out[k] != null && toMinutes(out[k]) == null) errors.push(`${k} must be HH:MM`);
  }
  if ((out.start_time == null) !== (out.end_time == null)) errors.push('start_time and end_time go together');
  for (const k of ['start_date', 'end_date']) {
    out[k] = b[k] == null || b[k] === '' ? null : String(b[k]).trim();
    if (out[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(out[k])) errors.push(`${k} must be YYYY-MM-DD`);
  }
  if (out.start_date && out.end_date && out.end_date < out.start_date) errors.push('end_date is before start_date');
  out.enabled = b.enabled === undefined ? 1 : (b.enabled ? 1 : 0);
  return { schedule: out, errors };
}

module.exports = { resolveLayout, validateSchedule, matches, partsIn, toMinutes };
