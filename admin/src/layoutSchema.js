// Client-side mirror of the server's layout validation — enough to give instant feedback while
// typing; the server re-validates on save.
import SHARED_ZONE_TYPES from '../../shared/zone-types.json';
import { upgradeLayout, validatePages } from '../../shared/layout-model.js';
export const ZONE_TYPES = SHARED_ZONE_TYPES;   // single source of truth shared with server and renderer

export function validateLayoutText(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return { doc: null, errors: ['Invalid JSON: ' + e.message] }; }
  return validateLayout(doc);
}

export function validateLayout(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { doc: null, errors: ['Layout must be an object'] };
  if (doc.schema !== undefined && doc.schema !== 1 && doc.schema !== 2) errors.push('schema must be 1 or 2');
  if (!Array.isArray(doc.zones)) errors.push('zones must be an array');
  else {
    const ids = new Set();
    doc.zones.forEach((z, i) => {
      if (!z || typeof z !== 'object') { errors.push(`zone ${i} must be an object`); return; }
      const id = z.id || `zone${i + 1}`;
      if (ids.has(id)) errors.push(`duplicate zone id "${id}"`);
      ids.add(id);
      if (!ZONE_TYPES.includes(z.type)) errors.push(`zone "${id}": unknown type "${z.type}"`);
      for (const k of ['x', 'y', 'w', 'h']) if (z[k] !== undefined && !Number.isFinite(Number(z[k]))) errors.push(`zone "${id}": ${k} must be a number`);
      if (z.type === 'slideshow' && z.images !== undefined && !Array.isArray(z.images)) errors.push(`zone "${id}": images must be an array`);
      if (z.type === 'ticker' && z.items !== undefined && !Array.isArray(z.items)) errors.push(`zone "${id}": items must be an array`);
      if (z.type === 'weather') { if (z.lat !== undefined && !(Math.abs(Number(z.lat)) <= 90)) errors.push(`zone "${id}": lat must be between -90 and 90`); if (z.lon !== undefined && !(Math.abs(Number(z.lon)) <= 180)) errors.push(`zone "${id}": lon must be between -180 and 180`); }
    });
    const videos = doc.zones.filter((z) => z && z.type === 'video');
    if (videos.length > 1) errors.push(`zone "${videos[1].id}": at most one video zone per layout (the player overlays a single region)`);
    if (doc.pages !== undefined && !Array.isArray(doc.pages)) errors.push('pages must be an array');
  }
  const v2 = Array.isArray(doc.zones) ? upgradeLayout(doc) : null;
  if (v2) for (const e of validatePages(v2)) errors.push(e);
  return { doc: errors.length ? null : v2, errors };
}
