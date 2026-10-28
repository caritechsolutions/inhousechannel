'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { validateLayout, mediaRefs, layoutTemplates, ZONE_TYPES } = require('../src/layout');
const { loadEsm } = require('../src/esm');
const { startServer } = require('../testlib/helpers');

const SHARED = path.resolve(__dirname, '../../shared');

test('zone-types.json is the signage list and every template validates', () => {
  assert.deepEqual(ZONE_TYPES, ['text', 'image', 'slideshow', 'video', 'ticker', 'clock', 'date', 'weather', 'qr', 'html', 'shape']);
  const tpl = layoutTemplates();
  assert.deepEqual(tpl.map((t) => t.id), ['lobby', 'menu', 'slideshow']);
  for (const t of tpl) assert.deepEqual(validateLayout(t.json).errors, [], t.id);
  // zone-draw.js registers a drawer for each type (textual check: no DOM here)
  const src = require('fs').readFileSync(path.join(SHARED, 'zone-draw.js'), 'utf8');
  const drawers = /export var DRAWERS = \{([\s\S]*?)\};/.exec(src)[1].match(/^\s*(\w+):/gm).map((m) => m.trim().replace(':', ''));
  assert.deepEqual(drawers.sort(), [...ZONE_TYPES].sort());
});

test('validateLayout rejects unknown zone types, >1 video zone, bad pages', () => {
  const base = { schema: 2, canvas: { w: 1920, h: 1080 }, zones: [], pages: [{ id: 'p', zones: [] }] };
  const bad = validateLayout({ ...base, zones: [{ id: 'm', type: 'menu', x: 0, y: 0, w: 10, h: 10 }] });
  assert.deepEqual(bad.errors, ['zone "m": unknown type "menu"']);
  const two = validateLayout({ ...base, zones: [{ id: 'v1', type: 'video', x: 0, y: 0, w: 10, h: 10 }, { id: 'v2', type: 'video', x: 0, y: 0, w: 10, h: 10 }] });
  assert.ok(two.errors.includes('at most one video zone'));
  const unknownRef = validateLayout({ ...base, pages: [{ id: 'p', zones: ['nope'] }] });
  assert.ok(unknownRef.errors.some((e) => /unknown zone "nope"/.test(e)));
  const dur = validateLayout({ ...base, pages: [{ id: 'p', zones: [], duration_s: -3 }] });
  assert.ok(dur.errors.some((e) => /duration_s/.test(e)));
  assert.equal(validateLayout({ ...base, pages: [] }).doc.pages.length, 1, 'an empty pages array gets a default page');
  assert.ok(validateLayout('{').errors[0].startsWith('invalid JSON'));
  assert.equal(validateLayout([]).doc, null);
});

test('upgrade: zones on no page land on the first page, TV fields are dropped, durations default', () => {
  const { doc, errors } = validateLayout({ zones: [{ id: 'a', type: 'text', text: 'hi', action: { type: 'goto_page' } }], keys: { PORTAL: 'x' }, focus: {}, home: 'zz' });
  assert.deepEqual(errors, []);
  assert.equal(doc.pages.length, 1);
  assert.deepEqual(doc.pages[0].zones, ['a']);
  assert.equal(doc.pages[0].duration_s, 15);
  assert.equal(doc.zones[0].action, undefined);
  assert.equal(doc.keys, undefined);
  assert.equal(doc.home, undefined);
  assert.equal(doc.schema, 2);
});

test('mediaRefs finds media:<id> tokens', () => {
  assert.deepEqual(mediaRefs({ canvas: { backgroundImage: 'media:7' }, zones: [{ src: 'media:12' }, { images: ['media:12', 'media:3'] }] }).sort((a, b) => a - b), [3, 7, 12]);
});

test('shared model helpers load in Node and cycle pages', () => {
  const m = loadEsm(path.join(SHARED, 'layout-model.js'));
  const layout = { pages: [{ id: 'a', zones: ['z1'], duration_s: 5 }, { id: 'b', zones: ['z2'] }], zones: [{ id: 'z1', type: 'text' }, { id: 'z2', type: 'text' }, { id: 'v', type: 'video' }] };
  assert.equal(m.nextPageId(layout, 'a'), 'b');
  assert.equal(m.nextPageId(layout, 'b'), 'a');
  assert.equal(m.pageDuration(layout.pages[0]), 5);
  assert.equal(m.pageDuration(layout.pages[1]), 15);
  assert.deepEqual(m.visibleZoneList(layout, 'b').map((z) => z.id), ['z2']);
  assert.equal(m.videoZone(layout).id, 'v');
});

test('qr.js encodes in Node (import-free) and sizes grow with the text', () => {
  const q = loadEsm(path.join(SHARED, 'qr.js'));
  const a = q.qrEncode('https://signage.caritech.net');
  assert.equal(a.size, 4 * a.version + 17);
  assert.equal(a.modules[0][0], true, 'finder pattern corner is dark');
  assert.equal(a.modules[a.size - 8][8], true, 'dark module');
  const b = q.qrEncode('x'.repeat(200), { ecl: 'L' });
  assert.ok(b.version > a.version);
  assert.equal(q.qrEncode('x'.repeat(400)), null, 'too long for version 10');
  assert.match(q.qrSvg('hi'), /^<svg /);
});

test('layout API: templates, create, validate, duplicate, update, in-use delete', async (t) => {
  const s = await startServer(); t.after(s.close);
  const site = s.addSite('A', 'a');
  const root = await s.login();
  const tpl = await s.call('GET', '/api/admin/layout-templates', { cookie: root.cookie });
  assert.equal(tpl.json.length, 3);
  const made = await s.call('POST', `/api/admin/sites/${site}/layouts`, { cookie: root.cookie, body: { name: 'Lobby', template: 'lobby' } });
  assert.equal(made.status, 201);
  assert.equal(made.json.json.zones.find((z) => z.type === 'ticker').id, 'ticker');
  assert.equal((await s.call('POST', `/api/admin/sites/${site}/layouts`, { cookie: root.cookie, body: { name: 'x', template: 'classic' } })).status, 400, 'TV template is gone');
  const bad = await s.call('POST', `/api/admin/sites/${site}/layouts`, { cookie: root.cookie, body: { name: 'Bad', json: { zones: [{ id: 'c', type: 'channel_list' }], pages: [{ id: 'p', zones: ['c'] }] } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unknown type "channel_list"/);
  const dup = await s.call('POST', `/api/admin/sites/${site}/layouts/${made.json.id}/duplicate`, { cookie: root.cookie });
  assert.equal(dup.json.name, 'Lobby copy');
  const upd = await s.call('PUT', `/api/admin/sites/${site}/layouts/${dup.json.id}`, { cookie: root.cookie, body: { name: 'Lobby 2', json: { ...dup.json.json, pages: [{ ...dup.json.json.pages[0], duration_s: 30 }] } } });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.name, 'Lobby 2');
  assert.equal(upd.json.json.pages[0].duration_s, 30);
  const v = await s.call('POST', `/api/admin/sites/${site}/layouts/validate`, { cookie: root.cookie, body: { zones: [{ id: 'a', type: 'video' }, { id: 'b', type: 'video' }], pages: [{ id: 'p', zones: ['a', 'b'] }] } });
  assert.equal(v.json.ok, false);
  assert.ok(v.json.errors.includes('at most one video zone'));
  // editor of the site can edit layouts; a stranger cannot see them
  s.addMember('ed@example.com', site, 'editor');
  const ed = await s.login('ed@example.com', 'password1');
  assert.equal((await s.call('GET', `/api/admin/sites/${site}/layouts`, { cookie: ed.cookie })).json.length, 2);
  const other = s.addSite('B', 'b');
  assert.equal((await s.call('GET', `/api/admin/sites/${other}/layouts`, { cookie: ed.cookie })).status, 404);
});
