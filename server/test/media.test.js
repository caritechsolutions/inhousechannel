'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, multipart, PNG } = require('../testlib/helpers');
const { haveFfmpeg, sniffExt } = require('../src/media');

test('sniffExt recognises the library types by magic bytes', () => {
  assert.equal(sniffExt(PNG), 'png');
  assert.equal(sniffExt(Buffer.from('wOF2' + 'x'.repeat(20))), 'woff2');
  assert.equal(sniffExt(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg');
  assert.equal(sniffExt(Buffer.from('ID3' + 'x'.repeat(20))), 'mp3');
  assert.equal(sniffExt(Buffer.from('#!/bin/sh\necho pwned\n' + 'x'.repeat(20))), null);
});

test('PNG upload (multipart) gets a thumbnail, dimensions, sha256; delete refuses while referenced', async (t) => {
  const s = await startServer(); t.after(s.close);
  const site = s.addSite('A', 'a');
  const root = await s.login();
  const body = multipart({ name: 'Logo' }, { filename: 'logo.png', type: 'image/png', data: PNG });
  const up = await s.call('POST', `/api/admin/sites/${site}/media`, { cookie: root.cookie, raw: body.raw, headers: body.headers });
  assert.equal(up.status, 201, up.text);
  assert.equal(up.json.kind, 'image');
  assert.equal(up.json.name, 'Logo');
  assert.equal(up.json.status, 'ready');
  assert.equal(up.json.width, 1);
  assert.equal(up.json.height, 1);
  assert.equal(up.json.size, PNG.length);
  assert.equal(up.json.sha256, require('crypto').createHash('sha256').update(PNG).digest('hex'));
  assert.ok(up.json.thumb_url, 'thumbnail made by sharp');
  const th = await s.call('GET', up.json.thumb_url, { cookie: root.cookie });
  assert.equal(th.status, 200);
  assert.equal(th.headers['content-type'], 'image/jpeg');
  assert.ok(fs.existsSync(path.join(s.dataDir, 'media', String(site))));
  // a renamed shell script is refused
  const bad = multipart({}, { filename: 'evil.png', type: 'image/png', data: Buffer.from('#!/bin/sh\necho no\n' + 'x'.repeat(600)) });
  assert.equal((await s.call('POST', `/api/admin/sites/${site}/media`, { cookie: root.cookie, raw: bad.raw, headers: bad.headers })).status, 400);
  // reference from a layout blocks delete; site logo too
  const lay = await s.call('POST', `/api/admin/sites/${site}/layouts`, { cookie: root.cookie, body: { name: 'L', json: { zones: [{ id: 'i', type: 'image', src: `media:${up.json.id}` }], pages: [{ id: 'p', zones: ['i'] }] } } });
  const del = await s.call('DELETE', `/api/admin/sites/${site}/media/${up.json.id}`, { cookie: root.cookie });
  assert.equal(del.status, 409);
  assert.equal(del.json.layouts[0].id, lay.json.id);
  assert.equal((await s.call('PATCH', `/api/admin/sites/${site}`, { cookie: root.cookie, body: { logo_media_id: up.json.id } })).status, 200);
  assert.equal((await s.call('GET', `/api/admin/sites/${site}/media/${up.json.id}/references`, { cookie: root.cookie })).json.logo, true);
  assert.equal((await s.call('DELETE', `/api/admin/sites/${site}/media/${up.json.id}?force=1`, { cookie: root.cookie })).status, 200);
  assert.deepEqual((await s.call('GET', `/api/admin/sites/${site}/media`, { cookie: root.cookie })).json, []);
});

test('video upload is normalised by ffmpeg to the 720p profile', { skip: !haveFfmpeg() && 'ffmpeg not installed' }, async (t) => {
  const s = await startServer(); t.after(s.close);
  const site = s.addSite('A', 'a');
  const root = await s.login();
  const src = path.join(s.dataDir, 'src.mp4');
  // 2 s of 640x360 test pattern, no audio → the normaliser must add a silent track
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', src]);
  const data = fs.readFileSync(src);
  const body = multipart({}, { filename: 'clip.mp4', type: 'video/mp4', data });
  const up = await s.call('POST', `/api/admin/sites/${site}/media`, { cookie: root.cookie, raw: body.raw, headers: body.headers });
  assert.equal(up.status, 201, up.text);
  assert.equal(up.json.kind, 'video');
  assert.equal(up.json.status, 'processing');
  // not offered to players until ready
  const p = await s.call('POST', `/api/admin/sites/${site}/players`, { cookie: root.cookie, body: { name: 'p' } });
  const auth = { Authorization: `Bearer ${p.json.key}` };
  assert.equal((await s.call('GET', `/api/player/media/${up.json.id}`, { headers: auth })).status, 404);
  await s.media.drain();
  const m = await s.call('GET', `/api/admin/sites/${site}/media/${up.json.id}`, { cookie: root.cookie });
  assert.equal(m.json.status, 'ready', m.json.error);
  assert.equal(m.json.width, 1280);
  assert.equal(m.json.height, 720);
  assert.equal(m.json.mime, 'video/mp4');
  assert.ok(m.json.duration_s > 1.5 && m.json.duration_s < 2.6, `duration ${m.json.duration_s}`);
  assert.equal(m.json.sha256.length, 64);
  const row = s.media.getRow(site, up.json.id);
  assert.notEqual(row.path, row.original_path, 'original kept beside the normalised file');
  assert.ok(fs.existsSync(row.original_path) && fs.existsSync(row.path));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,profile,r_frame_rate,sample_rate,channels', '-of', 'json', row.path]).toString());
  const v = probe.streams.find((x) => x.codec_type === 'video'), a = probe.streams.find((x) => x.codec_type === 'audio');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.profile, 'High');
  assert.equal(v.r_frame_rate, '30/1');
  assert.equal(a.codec_name, 'aac');
  assert.equal(a.sample_rate, '48000');
  assert.equal(a.channels, 2);
  const file = await s.call('GET', `/api/player/media/${up.json.id}`, { headers: auth });
  assert.equal(file.status, 200);
  assert.equal(file.buf.length, m.json.size);
});
