// Pure helpers for the canvas layout editor. Canvas units are layout pixels (1920x1080).
// Signage model (shared/layout-model.js): timed pages, each listing the zones it draws; no
// global/inherited zones, no actions, keys or focus.
import SHARED_ZONE_TYPES from '../../../shared/zone-types.json';
import FONTS_JSON from '../../../shared/fonts.json';
import * as draw from '../../../shared/zone-draw.js';
import { upgradeLayout, validatePages, pagesOf, pageById, firstPageId, DEFAULT_PAGE_DURATION_S } from '../../../shared/layout-model.js';
export { upgradeLayout, validatePages, pagesOf, pageById, DEFAULT_PAGE_DURATION_S };

export const GRID = 8;
export const MIN_SIZE = 40;
export const GUIDE_THRESHOLD = 6;     // canvas px within which an edge snaps to a guide
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const ZONE_TYPES = SHARED_ZONE_TYPES;   // shared/zone-types.json
export const SINGLETON_TYPES = ['video'];      // at most one per layout (ffmpeg overlays one region)
export const VARIABLES = (draw.VARIABLES && draw.VARIABLES.length ? draw.VARIABLES : ['site', 'time', 'date']).concat(['logo']);
export const FONTS = FONTS_JSON;
export const SHADOW_OPTIONS = [['', 'none'], ['soft', 'soft'], ['strong', 'strong'], ['outline', 'outline']];
export const PALETTE = [
  { group: 'Text', items: [['text', 'Text'], ['ticker', 'Ticker']] },
  { group: 'Pictures', items: [['image', 'Image'], ['slideshow', 'Slideshow'], ['shape', 'Shape']] },
  { group: 'Video', items: [['video', 'Video clips']] },
  { group: 'Time & weather', items: [['clock', 'Clock'], ['date', 'Date'], ['weather', 'Weather']] },
  { group: 'Web', items: [['qr', 'QR code'], ['html', 'Web page']] },
];
export const TYPE_LABELS = Object.fromEntries(PALETTE.flatMap((g) => g.items));

// The first page is the one the channel starts on (there is no "home" in the signage model).
export const homePageId = (doc) => firstPageId(doc);

export const snap = (v, grid = GRID) => Math.round(v / grid) * grid;

export function clampRect(r, canvas) {
  const w = Math.max(MIN_SIZE, Math.min(r.w, canvas.w));
  const h = Math.max(MIN_SIZE, Math.min(r.h, canvas.h));
  const x = Math.max(0, Math.min(r.x, canvas.w - w));
  const y = Math.max(0, Math.min(r.y, canvas.h - h));
  return { x, y, w, h };
}

// Move by (dx, dy) canvas px; snaps the top-left corner unless free.
export function dragRect(r, dx, dy, canvas, { free = false } = {}) {
  let x = r.x + dx, y = r.y + dy;
  if (!free) { x = snap(x); y = snap(y); }
  return clampRect({ ...r, x, y }, canvas);
}

// Resize from a handle by (dx, dy). Keeps the opposite edge fixed; snaps the moving edges.
export function resizeRect(r, handle, dx, dy, canvas, { free = false, aspect = null } = {}) {
  let { x, y, w, h } = r;
  const right = x + w, bottom = y + h;
  if (handle.includes('e')) w = Math.max(MIN_SIZE, w + dx);
  if (handle.includes('s')) h = Math.max(MIN_SIZE, h + dy);
  if (handle.includes('w')) { x = Math.min(x + dx, right - MIN_SIZE); w = right - x; }
  if (handle.includes('n')) { y = Math.min(y + dy, bottom - MIN_SIZE); h = bottom - y; }
  if (!free) {
    const nx = handle.includes('w') ? snap(x) : x;
    const ny = handle.includes('n') ? snap(y) : y;
    if (handle.includes('w')) { w = right - nx; x = nx; }
    if (handle.includes('n')) { h = bottom - ny; y = ny; }
    if (handle.includes('e')) w = snap(w);
    if (handle.includes('s')) h = snap(h);
    w = Math.max(MIN_SIZE, w); h = Math.max(MIN_SIZE, h);
  }
  if (aspect) {
    if (handle === 'n' || handle === 's') w = Math.round(h * aspect); else h = Math.round(w / aspect);
    if (handle.includes('w')) x = right - w;
    if (handle.includes('n')) y = bottom - h;
  }
  return clampRect({ x, y, w, h }, canvas);
}

// Smart guides: snap the rect's left/centre/right (and top/middle/bottom) to the same lines of
// other zones and of the canvas when within `threshold`. Returns the moved rect and the guide
// lines to draw ({axis:'x'|'y', pos}).
export function guideSnap(rect, others, canvas, threshold = GUIDE_THRESHOLD) {
  const xe = [0, canvas.w], xc = [canvas.w / 2], ye = [0, canvas.h], yc = [canvas.h / 2];
  for (const o of others) { xe.push(o.x, o.x + o.w); xc.push(o.x + o.w / 2); ye.push(o.y, o.y + o.h); yc.push(o.y + o.h / 2); }
  const best = (pairs) => {
    let hit = null;
    for (const [cands, v] of pairs) for (const c of cands) { const d = c - v; if (Math.abs(d) <= threshold && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, pos: c }; }
    return hit;
  };
  const hx = best([[xe, rect.x], [xc, rect.x + rect.w / 2], [xe, rect.x + rect.w]]);
  const hy = best([[ye, rect.y], [yc, rect.y + rect.h / 2], [ye, rect.y + rect.h]]);
  const out = { ...rect };
  const guides = [];
  if (hx) { out.x = rect.x + hx.d; guides.push({ axis: 'x', pos: hx.pos }); }
  if (hy) { out.y = rect.y + hy.d; guides.push({ axis: 'y', pos: hy.pos }); }
  return { rect: clampRect(out, canvas), guides };
}

export function selectionBounds(zones) {
  if (!zones.length) return null;
  const x1 = Math.min(...zones.map((z) => z.x)), y1 = Math.min(...zones.map((z) => z.y));
  const x2 = Math.max(...zones.map((z) => z.x + z.w)), y2 = Math.max(...zones.map((z) => z.y + z.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
// Align the selected zones: to each other when 2+, to the canvas when 1.
export function alignZones(doc, ids, how) {
  const canvas = doc.canvas || { w: 1920, h: 1080 };
  const sel = doc.zones.filter((z) => ids.includes(z.id) && !z.locked);
  if (!sel.length) return doc;
  const b = sel.length > 1 ? selectionBounds(sel) : { x: 0, y: 0, w: canvas.w, h: canvas.h };
  const moved = {};
  for (const z of sel) {
    const r = { x: z.x, y: z.y };
    if (how === 'left') r.x = b.x;
    if (how === 'center') r.x = Math.round(b.x + b.w / 2 - z.w / 2);
    if (how === 'right') r.x = b.x + b.w - z.w;
    if (how === 'top') r.y = b.y;
    if (how === 'middle') r.y = Math.round(b.y + b.h / 2 - z.h / 2);
    if (how === 'bottom') r.y = b.y + b.h - z.h;
    moved[z.id] = clampRect({ ...z, ...r }, canvas);
  }
  return { ...doc, zones: doc.zones.map((z) => (moved[z.id] ? { ...z, ...moved[z.id] } : z)) };
}
// Equal gaps between 3+ zones along an axis (first and last stay put).
export function distributeZones(doc, ids, axis) {
  const sel = doc.zones.filter((z) => ids.includes(z.id) && !z.locked);
  if (sel.length < 3) return doc;
  const k = axis === 'x' ? ['x', 'w'] : ['y', 'h'];
  const sorted = sel.slice().sort((a, b) => a[k[0]] - b[k[0]]);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const total = (last[k[0]] + last[k[1]]) - first[k[0]];
  const sizes = sorted.reduce((a, z) => a + z[k[1]], 0);
  const gap = (total - sizes) / (sorted.length - 1);
  const moved = {};
  let cur = first[k[0]];
  for (const z of sorted) { moved[z.id] = Math.round(cur); cur += z[k[1]] + gap; }
  return { ...doc, zones: doc.zones.map((z) => (moved[z.id] != null ? { ...z, [k[0]]: moved[z.id] } : z)) };
}

const fileName = (s) => (String(s || '').split('/').pop() || '').split('?')[0];
export function zoneLabel(z) {
  switch (z.type) {
    case 'text': return (z.text || '').split('\n')[0].slice(0, 40) || 'text';
    case 'image': return z.src === '{{logo}}' ? 'site logo' : /^media:/.test(z.src || '') ? z.src : fileName(z.src) || 'image (pick one)';
    case 'slideshow': return `slideshow (${(z.images || []).length} images)`;
    case 'video': return `video (${(z.playlist || []).length} clips)`;
    case 'ticker': return (Array.isArray(z.items) && z.items.length ? z.items[0] : z.text || '').slice(0, 40) || 'ticker';
    case 'clock': return z.format || 'HH:mm';
    case 'date': return z.format || 'dddd D MMMM YYYY';
    case 'weather': return 'weather';
    case 'qr': return (z.data || '').slice(0, 40) || 'qr (no data)';
    case 'html': return fileName(z.url) || z.url || 'web page';
    case 'shape': return z.shape === 'ellipse' ? 'ellipse' : 'rectangle';
    default: return z.type;
  }
}

export function nextZoneId(doc, type) {
  const ids = new Set((doc.zones || []).map((z) => z.id));
  const base = type;
  if (!ids.has(base)) return base;
  let i = 2;
  while (ids.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

export function newZone(doc, type, at) {
  const id = nextZoneId(doc, type);
  const c = doc.canvas || { w: 1920, h: 1080 };
  const base = { id, type, x: snap(c.w * 0.1), y: snap(c.h * 0.1) };
  let z;
  switch (type) {
    case 'text': z = { ...base, w: 800, h: 90, text: 'New text', style: { fontSize: 48, color: '#ffffff' } }; break;
    case 'ticker': z = { ...base, x: 0, y: 960, w: c.w, h: 120, items: ['Welcome to {{site}}'], speed: 120, style: { fontSize: 44, color: '#ffffff', background: 'rgba(0,0,0,0.45)' } }; break;
    case 'image': z = { ...base, w: 480, h: 270, src: '', fit: 'contain' }; break;
    case 'slideshow': z = { ...base, w: 960, h: 540, images: [], interval_s: 8, fade: true, fit: 'cover' }; break;
    case 'shape': z = { ...base, w: 400, h: 200, shape: 'rect', fill: 'rgba(255,255,255,0.15)', radius: 16 }; break;
    case 'video': z = { ...base, x: 640, y: 120, w: 1200, h: 675, playlist: [], loop: true, mute: false }; break;
    case 'clock': z = { ...base, w: 320, h: 90, format: 'HH:mm', style: { fontSize: 72, color: '#ffffff', align: 'right' } }; break;
    case 'date': z = { ...base, w: 700, h: 50, format: 'dddd D MMMM YYYY', style: { fontSize: 32, color: '#ffffff', align: 'right' } }; break;
    case 'weather': z = { ...base, w: 420, h: 120, units: 'metric', lat: 13.1, lon: -59.6, showText: true, style: { fontSize: 40, color: '#ffffff' } }; break;
    case 'qr': z = { ...base, w: 240, h: 240, data: 'https://', fg: '#000000', bg: '#ffffff', style: { padding: 12, background: '#ffffff', borderRadius: 12 } }; break;
    case 'html': z = { ...base, w: 1200, h: 700, url: '' }; break;
    default: z = { ...base, w: 300, h: 200 };
  }
  if (at) Object.assign(z, clampRect({ ...z, x: snap(at.x - z.w / 2), y: snap(at.y - z.h / 2) }, c));
  return z;
}

// ---- immutable document edits
export function updateZone(doc, id, patch) {
  return { ...doc, zones: doc.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) };
}
export function updateZones(doc, ids, fn) {
  return { ...doc, zones: doc.zones.map((z) => (ids.includes(z.id) ? { ...z, ...fn(z) } : z)) };
}
export function renameZone(doc, id, newId) {
  if (!newId || newId === id || doc.zones.some((z) => z.id === newId)) return doc;
  return { ...doc,
    zones: doc.zones.map((z) => (z.id === id ? { ...z, id: newId } : z)),
    pages: pagesOf(doc).map((p) => ({ ...p, zones: p.zones.map((zid) => (zid === id ? newId : zid)) })) };
}
export function removeZone(doc, idOrIds) {
  const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
  return { ...doc, zones: doc.zones.filter((z) => !ids.includes(z.id)), pages: pagesOf(doc).map((p) => ({ ...p, zones: p.zones.filter((zid) => !ids.includes(zid)) })) };
}
export function addZone(doc, type, pageId, at) {
  const z = newZone(doc, type, at);
  const pages = pagesOf(doc).map((p) => (p.id === pageId ? { ...p, zones: [...p.zones, z.id] } : p));
  return { doc: { ...doc, zones: [...doc.zones, z], pages }, zone: z };
}
export function duplicateZone(doc, idOrIds, pageId) {
  const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
  let out = doc; const zones = [];
  for (const id of ids) {
    const src = out.zones.find((z) => z.id === id);
    if (!src) continue;
    if (SINGLETON_TYPES.includes(src.type)) continue;   // only one video region per layout
    const copy = { ...JSON.parse(JSON.stringify(src)), id: nextZoneId(out, src.type), x: src.x + GRID * 2, y: src.y + GRID * 2, locked: undefined };
    const pages = pagesOf(out).map((p) => (p.id === pageId ? { ...p, zones: [...p.zones, copy.id] } : p));
    out = { ...out, zones: [...out.zones, copy], pages };
    zones.push(copy);
  }
  return { doc: out, zone: zones[0], zones };
}
// Z-order. With a pageId the move is relative to that page's zones only (their slots in
// doc.zones are re-filled in the new order; zones of other pages keep their positions).
export function moveZoneOrder(doc, id, dir, pageId) { // dir: -1 back, +1 front, 'front', 'back'
  const peers = pageId ? editableZoneIds(doc, pageId) : doc.zones.map((z) => z.id);
  const k = peers.indexOf(id);
  if (k < 0) return doc;
  const j = dir === 'front' ? peers.length - 1 : dir === 'back' ? 0 : k + dir;
  if (j < 0 || j >= peers.length || j === k) return doc;
  const order = peers.slice(); order.splice(k, 1); order.splice(j, 0, id);
  const byId = Object.fromEntries(doc.zones.map((z) => [z.id, z]));
  let n = 0;
  const zones = doc.zones.map((z) => (peers.includes(z.id) ? byId[order[n++]] : z));
  return { ...doc, zones };
}
export function zoneOrderIndex(doc, id, pageId) {   // position among the page's zones (or all)
  const peers = pageId ? editableZoneIds(doc, pageId) : doc.zones.map((z) => z.id);
  return { index: peers.indexOf(id), count: peers.length };
}
// Only the zones a page lists are drawn and editable on it, in stacking order.
export function editableZoneIds(doc, pageId) {
  const p = pageById(doc, pageId);
  const ids = new Set((p && p.zones) || []);
  return doc.zones.filter((z) => ids.has(z.id)).map((z) => z.id);
}

// ---- pages
export function isOnPage(doc, pageId, zoneId) {
  const p = pageById(doc, pageId);
  return !!p && p.zones.includes(zoneId);
}
export function toggleZoneInPage(doc, pageId, zoneId) {
  return { ...doc, pages: pagesOf(doc).map((p) => {
    if (p.id !== pageId) return p;
    return p.zones.includes(zoneId) ? { ...p, zones: p.zones.filter((z) => z !== zoneId) } : { ...p, zones: [...p.zones, zoneId] };
  }) };
}
export function pageSlug(name, doc) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
  const ids = new Set(pagesOf(doc).map((p) => p.id));
  if (!ids.has(base)) return base;
  let i = 2; while (ids.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
export function addPage(doc, name, duration_s = DEFAULT_PAGE_DURATION_S) {
  const n = String(name || '').trim() || 'New page';
  const page = { id: pageSlug(n, doc), name: n, zones: [], duration_s };
  return { doc: { ...doc, pages: [...pagesOf(doc), page] }, page };
}
export function renamePage(doc, id, name) {
  const n = String(name || '').trim();
  if (!n) return doc;
  return { ...doc, pages: pagesOf(doc).map((p) => (p.id === id ? { ...p, name: n } : p)) };
}
export function setPageDuration(doc, id, duration_s) {
  const d = Number(duration_s);
  return { ...doc, pages: pagesOf(doc).map((p) => (p.id === id ? { ...p, duration_s: Number.isFinite(d) && d > 0 ? d : DEFAULT_PAGE_DURATION_S } : p)) };
}
export function movePage(doc, id, toIndex) {
  const pages = pagesOf(doc).slice();
  const i = pages.findIndex((p) => p.id === id);
  if (i < 0 || toIndex < 0 || toIndex >= pages.length || toIndex === i) return doc;
  const [p] = pages.splice(i, 1); pages.splice(toIndex, 0, p);
  return { ...doc, pages };
}
// Deleting a page removes the zones only it used.
export function removePage(doc, id) {
  const pages = pagesOf(doc);
  if (pages.length < 2) return doc;
  const page = pageById(doc, id);
  if (!page) return doc;
  const rest = pages.filter((p) => p.id !== id);
  const usedElsewhere = new Set(rest.flatMap((p) => p.zones));
  const orphan = new Set(page.zones.filter((zid) => !usedElsewhere.has(zid)));
  return { ...doc, pages: rest, zones: doc.zones.filter((z) => !orphan.has(z.id)) };
}
// Duplicate: every zone is deep-copied with a new id (the video region, being a singleton,
// is shared between the two pages instead).
export function duplicatePage(doc, id) {
  const page = pageById(doc, id);
  if (!page) return { doc };
  let out = doc;
  const copyIds = [];
  for (const zid of page.zones) {
    const z = out.zones.find((x) => x.id === zid);
    if (!z) continue;
    if (SINGLETON_TYPES.includes(z.type)) { copyIds.push(zid); continue; }
    const copy = { ...JSON.parse(JSON.stringify(z)), id: nextZoneId(out, z.type) };
    out = { ...out, zones: [...out.zones, copy] };
    copyIds.push(copy.id);
  }
  const np = { id: pageSlug(page.name + ' copy', out), name: page.name + ' copy', zones: copyIds, duration_s: page.duration_s || DEFAULT_PAGE_DURATION_S };
  const pages = pagesOf(out).slice(); pages.splice(pages.findIndex((p) => p.id === id) + 1, 0, np);
  return { doc: { ...out, pages }, page: np };
}
export function ensurePages(doc) { return upgradeLayout(doc); }
export function totalCycleSeconds(doc) { return pagesOf(doc).reduce((a, p) => a + (Number(p.duration_s) > 0 ? Number(p.duration_s) : DEFAULT_PAGE_DURATION_S), 0); }

// Validation messages → { zoneId: [messages] } for inline badges (messages mention zone "id").
export function errorsByZone(errors) {
  const out = {};
  for (const e of errors || []) { const m = /zone "([^"]+)"/.exec(e); if (m) (out[m[1]] = out[m[1]] || []).push(e); }
  return out;
}
