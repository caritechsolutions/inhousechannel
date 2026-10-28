function parseIso(iso) {
  if (!iso) return null;
  const s = String(iso);
  // SQLite "YYYY-MM-DD HH:MM:SS" is UTC without a zone marker.
  const fixed = /Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(fixed);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function timeAgo(iso) {
  const d = parseIso(iso);
  if (!d) return 'never';
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtDate(iso) {
  const d = parseIso(iso);
  if (!d) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
export function fmtUptime(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export function fmtBytes(n) {
  if (n == null) return '—';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' kB';
}
export function fmtDuration(s) {
  if (s == null) return '';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
export function classNames(...xs) { return xs.filter(Boolean).join(' '); }

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];   // bit0 = Mon … bit6 = Sun
export const ALL_DAYS = 127;
export function dayOn(mask, i) { return ((mask ?? ALL_DAYS) >> i) & 1; }
export function toggleDay(mask, i) { return (mask ?? ALL_DAYS) ^ (1 << i); }
export function daysText(mask) {
  const m = mask ?? ALL_DAYS;
  if (m === ALL_DAYS) return 'every day';
  if (m === 31) return 'weekdays';
  if (m === 96) return 'weekends';
  return DAY_LABELS.filter((_, i) => dayOn(m, i)).join(', ') || 'never';
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
