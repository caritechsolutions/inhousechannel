// Signage layout document model (schema 2, adapted from codenameduck). Shared by the server
// validator (loaded through server/src/esm.js), the player renderer page and the admin editor.
// No imports, ES2015-safe, pure functions only.
//
// Shape:
//   { schema: 2, name, canvas: {w, h, background, backgroundImage},
//     zones: [{id, type, x, y, w, h, style, ...per-type fields}],
//     pages: [{id, name, zones: [ids], duration_s}] }
// Pages are timed: the renderer shows them one at a time, each for duration_s seconds, in
// order, and loops. Zones listed on no page are never drawn. At most one zone of type
// `video` may exist (ffmpeg composites the clip there; the page draws a transparent hole).

export var DEFAULT_PAGE_DURATION_S = 15;
export var SINGLETON_TYPES = ['video'];

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function titleCase(s) { return String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
function posNum(v, d) { var n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n > 0 ? n : d; }

export function pagesOf(layout) { return (layout && Array.isArray(layout.pages)) ? layout.pages : []; }
export function firstPageId(layout) { var p = pagesOf(layout); return p.length ? p[0].id : null; }
export function pageById(layout, id) {
  var pages = pagesOf(layout);
  for (var i = 0; i < pages.length; i++) if (pages[i].id === id) return pages[i];
  return null;
}
export function pageDuration(page) { return posNum(page && page.duration_s, DEFAULT_PAGE_DURATION_S); }
// The page after `pageId` in the cycle (wraps). Null when the layout has no pages.
export function nextPageId(layout, pageId) {
  var pages = pagesOf(layout);
  if (!pages.length) return null;
  for (var i = 0; i < pages.length; i++) if (pages[i].id === pageId) return pages[(i + 1) % pages.length].id;
  return pages[0].id;
}
// Zones a page draws, in stacking order (the zones array order).
export function visibleZoneList(layout, pageId) {
  layout = layout || {};
  var page = pageById(layout, pageId) || pageById(layout, firstPageId(layout));
  if (!page) return [];
  var on = {}; (page.zones || []).forEach(function (id) { on[id] = true; });
  return (layout.zones || []).filter(function (z) { return z && on[z.id]; });
}
export function videoZone(layout) {
  var zs = (layout && layout.zones) || [];
  for (var i = 0; i < zs.length; i++) if (zs[i] && zs[i].type === 'video') return zs[i];
  return null;
}

export function isV2(doc) { return !!(doc && doc.schema === 2 && Array.isArray(doc.pages)); }

// Normalise a document (or a coopcentric v1/v2 one) to the signage shape: drops TV-only
// fields (keys, focus, home, actions), gives every page a duration and a name, and puts every
// zone referenced by no page on the first page so nothing silently disappears. Never throws
// on junk: the validator reports what is left.
export function upgradeLayout(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  var doc = clone(input);
  var zones = Array.isArray(doc.zones) ? doc.zones.filter(function (z) { return z && typeof z === 'object'; }) : [];
  var pages = [];
  var src = Array.isArray(doc.pages) ? doc.pages : Array.isArray(doc.screens) ? doc.screens : [];
  src.forEach(function (p, i) {
    if (!p || typeof p !== 'object') return;
    var id = typeof p.id === 'string' && p.id ? p.id : 'page' + (i + 1);
    if (pages.some(function (q) { return q.id === id; })) return;
    pages.push({ id: id, name: typeof p.name === 'string' && p.name.trim() ? p.name : titleCase(id),
      zones: Array.isArray(p.zones) ? p.zones.filter(function (x) { return typeof x === 'string'; }) : [],
      duration_s: p.duration_s == null || p.duration_s === '' ? DEFAULT_PAGE_DURATION_S : (Number(p.duration_s) > 0 ? Number(p.duration_s) : p.duration_s) });   // invalid values are kept for validatePages to report
  });
  if (!pages.length) pages.push({ id: 'page1', name: 'Page 1', zones: zones.map(function (z) { return z.id; }), duration_s: DEFAULT_PAGE_DURATION_S });
  var placed = {}; pages.forEach(function (p) { p.zones.forEach(function (id) { placed[id] = true; }); });
  zones.forEach(function (z) { if (z.id && !placed[z.id]) pages[0].zones.push(z.id); });
  doc.pages = pages;
  doc.zones = zones.map(function (z) {
    var c = clone(z);
    delete c.hidden; delete c.action; delete c.focusStyle;   // (items stays: ticker lines)
    return c;
  });
  delete doc.screens; delete doc.home; delete doc.keys; delete doc.focus; delete doc.back_on_home;
  doc.schema = 2;
  return doc;
}

// Page-level validation shared by server and admin. Returns error strings (zone messages use
// the `zone "id": …` form so the editor can pin them to the zone).
export function validatePages(doc) {
  var errors = [];
  var zoneIds = {}; (doc.zones || []).forEach(function (z) { if (z && z.id) zoneIds[z.id] = z; });
  var pages = pagesOf(doc);
  if (!pages.length) { errors.push('layout needs at least one page'); return errors; }
  var seen = {};
  pages.forEach(function (p, i) {
    if (!p.id || typeof p.id !== 'string') errors.push('page ' + (i + 1) + ' needs an id');
    else if (seen[p.id]) errors.push('duplicate page id "' + p.id + '"'); else seen[p.id] = true;
    if (p.duration_s != null && !(Number(p.duration_s) > 0)) errors.push('page "' + p.id + '": duration_s must be a positive number of seconds');
    (p.zones || []).forEach(function (zid) { if (!zoneIds[zid]) errors.push('page "' + p.id + '" references unknown zone "' + zid + '"'); });
  });
  return errors;
}
