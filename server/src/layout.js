'use strict';
// Layout validation against the shared model (shared/layout-model.js, loaded without a build
// step) and the shared zone-type list. Also: template access and the media references a
// layout makes (`media:<id>` in src / images / backgroundImage) so the manifest can list them.
const path = require('path');
const { loadEsm } = require('./esm');

const SHARED = path.resolve(__dirname, '../../shared');
const model = loadEsm(path.join(SHARED, 'layout-model.js'));
const ZONE_TYPES = require(path.join(SHARED, 'zone-types.json'));
const TEMPLATES = require(path.join(SHARED, 'layout-templates.json'));
const { upgradeLayout, validatePages, SINGLETON_TYPES } = model;

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// Validate + normalise a layout document. Returns { doc, errors } (doc is null only when the
// input is not even an object).
function validateLayout(input) {
  const errors = [];
  let doc = input;
  if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch (e) { return { doc: null, errors: ['invalid JSON: ' + e.message] }; } }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { doc: null, errors: ['layout must be an object'] };
  if (doc.schema !== undefined && doc.schema !== 2) errors.push('schema must be 2');
  doc = upgradeLayout(doc);
  const out = { schema: 2 };
  out.name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim().slice(0, 80) : 'Untitled';
  const c = doc.canvas && typeof doc.canvas === 'object' ? doc.canvas : {};
  out.canvas = {
    w: num(c.w, 1920), h: num(c.h, 1080),
    background: typeof c.background === 'string' ? c.background : '#000000',
    backgroundImage: typeof c.backgroundImage === 'string' && c.backgroundImage ? c.backgroundImage : null,
  };
  if (!Array.isArray(doc.zones)) { errors.push('zones must be an array'); out.zones = []; }
  else {
    const ids = new Set();
    out.zones = doc.zones.map((z, i) => {
      if (!z || typeof z !== 'object') { errors.push(`zone ${i} must be an object`); return null; }
      const id = typeof z.id === 'string' && z.id.trim() ? z.id.trim() : `zone${i + 1}`;
      if (ids.has(id)) errors.push(`duplicate zone id "${id}"`);
      ids.add(id);
      if (!ZONE_TYPES.includes(z.type)) errors.push(`zone "${id}": unknown type "${z.type}"`);
      for (const k of ['x', 'y', 'w', 'h']) if (z[k] !== undefined && !Number.isFinite(Number(z[k]))) errors.push(`zone "${id}": ${k} must be a number`);
      if (z.type === 'slideshow' && z.images !== undefined && !Array.isArray(z.images)) errors.push(`zone "${id}": images must be an array`);
      if (z.type === 'ticker' && z.items !== undefined && !Array.isArray(z.items)) errors.push(`zone "${id}": items must be an array`);
      return { ...z, id, x: num(z.x, 0), y: num(z.y, 0), w: num(z.w, 200), h: num(z.h, 100) };
    }).filter(Boolean);
    for (const t of SINGLETON_TYPES) if (out.zones.filter((z) => z.type === t).length > 1) errors.push(`at most one ${t} zone`);
  }
  out.pages = doc.pages;
  for (const e of validatePages(out)) errors.push(e);
  return { doc: out, errors };
}

// Media ids a layout references, as numbers (unique).
function mediaRefs(doc) {
  const ids = new Set();
  for (const m of JSON.stringify(doc || {}).matchAll(/media:(\d+)/g)) ids.add(Number(m[1]));
  return [...ids];
}

function layoutTemplates() { return TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, json: t.json })); }
function templateLayout(id, name = 'New layout') {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  return { ...JSON.parse(JSON.stringify(t.json)), name };
}
function blankLayout(name = 'New layout') {
  return { schema: 2, name, canvas: { w: 1920, h: 1080, background: '#0b1a2a', backgroundImage: null }, zones: [], pages: [{ id: 'page1', name: 'Page 1', zones: [], duration_s: 15 }] };
}

module.exports = { validateLayout, mediaRefs, layoutTemplates, templateLayout, blankLayout, model, ZONE_TYPES, SHARED };
