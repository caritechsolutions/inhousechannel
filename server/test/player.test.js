'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { startServer, PNG } = require('../testlib/helpers');

test('player create → pair key works on the manifest; ETag/304; heartbeat; rotate', async (t) => {
  const s = await startServer({ publicUrl: 'https://signage.caritech.net' }); t.after(s.close);
  const site = s.addSite('Hotel A', 'a');
  const root = await s.login();
  const created = await s.call('POST', `/api/admin/sites/${site}/players`, { cookie: root.cookie, body: { name: 'test modulator' } });
  assert.equal(created.status, 201);
  assert.match(created.json.key, /^ihc_/);
  assert.equal(created.json.pair, `inhousechannel-player pair https://signage.caritech.net ${created.json.key}`);
  assert.equal(created.json.key_tail, created.json.key.slice(-4));
  assert.equal(created.json.resolution, '1280x720');
  // the key is never shown again
  const list = await s.call('GET', `/api/admin/sites/${site}/players`, { cookie: root.cookie });
  assert.equal(list.json[0].key, undefined);

  assert.equal((await s.call('GET', '/api/player/manifest')).status, 401);
  assert.equal((await s.call('GET', '/api/player/manifest', { headers: { Authorization: 'Bearer ihc_nope' } })).status, 401);
  const auth = { Authorization: `Bearer ${created.json.key}` };
  const m1 = await s.call('GET', '/api/player/manifest', { headers: auth });
  assert.equal(m1.status, 200);
  assert.equal(m1.json.player.name, 'test modulator');
  assert.equal(m1.json.player.site_tz, 'America/Barbados');
  assert.deepEqual(m1.json.layouts, []);
  assert.equal(m1.json.current_layout_id, null);
  const etag = m1.headers.etag;
  assert.ok(etag);
  assert.equal((await s.call('GET', '/api/player/manifest', { headers: { ...auth, 'If-None-Match': etag } })).status, 304);

  // assign a layout: manifest changes, ETag changes, media referenced is listed
  const up = await s.call('POST', `/api/admin/sites/${site}/media`, { cookie: root.cookie, raw: PNG, headers: { 'Content-Type': 'image/png', 'X-Filename': 'logo.png' } });
  assert.equal(up.status, 201);
  const lay = await s.call('POST', `/api/admin/sites/${site}/layouts`, { cookie: root.cookie, body: { name: 'Lobby', json: {
    schema: 2, canvas: { w: 1920, h: 1080 }, zones: [{ id: 'logo', type: 'image', x: 0, y: 0, w: 400, h: 200, src: `media:${up.json.id}` }], pages: [{ id: 'p', zones: ['logo'], duration_s: 10 }] } } });
  assert.equal(lay.status, 201);
  const patched = await s.call('PATCH', `/api/admin/sites/${site}/players/${created.json.id}`, { cookie: root.cookie, body: { default_layout_id: lay.json.id, resolution: '1920x1080' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.current_layout_id, lay.json.id);
  const m2 = await s.call('GET', '/api/player/manifest', { headers: { ...auth, 'If-None-Match': etag } });
  assert.equal(m2.status, 200);
  assert.notEqual(m2.headers.etag, etag);
  assert.equal(m2.json.current_layout_id, lay.json.id);
  assert.equal(m2.json.layouts[0].json.pages[0].duration_s, 10);
  assert.equal(m2.json.media.length, 1);
  assert.equal(m2.json.media[0].url, `/api/player/media/${up.json.id}`);
  assert.equal(m2.json.media[0].sha256.length, 64);
  const file = await s.call('GET', m2.json.media[0].url, { headers: auth });
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'image/png');
  assert.equal(file.buf.length, PNG.length);
  const range = await s.call('GET', m2.json.media[0].url, { headers: { ...auth, Range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(range.buf.length, 4);
  // another site's player cannot fetch it
  const other = s.addSite('Hotel B', 'b');
  const p2 = await s.call('POST', `/api/admin/sites/${other}/players`, { cookie: root.cookie, body: { name: 'b1' } });
  assert.equal((await s.call('GET', m2.json.media[0].url, { headers: { Authorization: `Bearer ${p2.json.key}` } })).status, 404);

  // heartbeat + thumbnail show up in the admin view
  const hb = await s.call('POST', '/api/player/heartbeat', { headers: auth, body: { version: '0.2.0', uptime_s: 100, layout_id: lay.json.id, cpu_pct: 61.5, fps: 30, bitrate_kbps: 9800, output: { address: '239.1.1.10', port: 1234 } } });
  assert.equal(hb.status, 200);
  assert.equal(hb.json.current_layout_id, lay.json.id);
  const th = await s.call('POST', '/api/player/thumbnail', { headers: { ...auth, 'Content-Type': 'image/jpeg' }, raw: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]) });
  assert.equal(th.status, 200);
  const view = await s.call('GET', `/api/admin/sites/${site}/players/${created.json.id}`, { cookie: root.cookie });
  assert.equal(view.json.online, true);
  assert.equal(view.json.version, '0.2.0');
  assert.equal(view.json.status.cpu_pct, 61.5);
  assert.equal(view.json.output.port, 1234);
  assert.equal(view.json.current_layout_name, 'Lobby');
  assert.ok(view.json.thumbnail_url);
  const thumb = await s.call('GET', view.json.thumbnail_url, { cookie: root.cookie });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.buf.length, 6);

  // rotate: old key dies, new one works
  const rot = await s.call('POST', `/api/admin/sites/${site}/players/${created.json.id}/rotate-key`, { cookie: root.cookie });
  assert.equal(rot.status, 200);
  assert.equal((await s.call('GET', '/api/player/manifest', { headers: auth })).status, 401);
  assert.equal((await s.call('GET', '/api/player/manifest', { headers: { Authorization: `Bearer ${rot.json.key}` } })).status, 200);
  assert.equal((await s.call('GET', '/api/player/time')).status, 200);
});

test('renderer bundle is a zip with ETag/304', async (t) => {
  const s = await startServer(); t.after(s.close);
  const site = s.addSite('A', 'a');
  const root = await s.login();
  const p = await s.call('POST', `/api/admin/sites/${site}/players`, { cookie: root.cookie, body: { name: 'p' } });
  const auth = { Authorization: `Bearer ${p.json.key}` };
  const z = await s.call('GET', '/api/player/renderer', { headers: auth });
  assert.equal(z.status, 200);
  assert.equal(z.headers['content-type'], 'application/zip');
  assert.equal(z.buf.readUInt32LE(0), 0x04034b50);
  assert.equal((await s.call('GET', '/api/player/renderer', { headers: { ...auth, 'If-None-Match': z.headers.etag } })).status, 304);
  // names present in the central directory; render.html inflates to something that imports zone-draw.js
  const names = [];
  for (let i = z.buf.indexOf('PK\x01\x02', 0, 'latin1'); i >= 0; i = z.buf.indexOf('PK\x01\x02', i + 4, 'latin1')) names.push(z.buf.slice(i + 46, i + 46 + z.buf.readUInt16LE(i + 28)).toString());
  for (const f of ['zone-draw.js', 'layout-model.js', 'qr.js', 'zones.css', 'fonts/fonts.css', 'fonts/inter.woff2', 'render.html']) assert.ok(names.includes(f), f);
  const built = s.renderer.build();
  assert.match(built.zip.toString('latin1'), /PK\x03\x04/);
  // decompress render.html entry by hand: local header → deflate-raw data
  const idx = built.zip.indexOf(Buffer.from('render.html'));
  const lh = idx - 30;
  const csize = built.zip.readUInt32LE(lh + 18), nlen = built.zip.readUInt16LE(lh + 26), method = built.zip.readUInt16LE(lh + 8);
  const data = built.zip.slice(lh + 30 + nlen, lh + 30 + nlen + csize);
  const html = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
  assert.match(html, /import \{ runPages, tick, liveContext \} from '\.\/zone-draw\.js'/);
});
