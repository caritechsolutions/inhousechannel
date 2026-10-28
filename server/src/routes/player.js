'use strict';
// Player API: bearer key issued per player. Everything here is cheap and cacheable because
// ~50 boxes poll it every 60 s with If-None-Match.
const express = require('express');
const fs = require('fs');
const path = require('path');

const THUMB_MAX = 300 * 1024;

function createPlayerRouter({ db, players, media, renderer, dataDir, log = () => {} }) {
  const r = express.Router();
  const thumbDir = dataDir ? path.join(dataDir, 'thumbs', 'players') : null;

  r.get('/time', (_req, res) => res.json({ time: new Date().toISOString(), epoch_ms: Date.now() }));

  r.use((req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const p = players.byKey(m ? m[1] : null);
    if (!p) return res.status(401).json({ error: 'invalid player key' });
    req.player = p;
    next();
  });

  r.get('/manifest', (req, res) => {
    const m = players.manifest(req.player);
    const etag = players.manifestEtag(m);
    res.set('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.json(m);
  });

  r.get('/media/:id', (req, res) => {
    const row = media.getRow(req.player.site_id, req.params.id);
    if (!row || row.status !== 'ready') return res.status(404).json({ error: 'media not found' });
    res.set('Cache-Control', 'private, max-age=86400');
    if (row.sha256) res.set('ETag', `"${row.sha256}"`);
    res.sendFile(media.filePath(row), { headers: { 'Content-Type': row.mime }, acceptRanges: true, lastModified: true, cacheControl: false, etag: false }, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).json({ error: 'cannot read media' });
    });
  });

  r.get('/renderer', (req, res) => {
    const b = renderer.build();
    res.set('ETag', b.etag);
    if (req.headers['if-none-match'] === b.etag) return res.status(304).end();
    res.set('Content-Type', 'application/zip').set('Content-Disposition', 'attachment; filename="renderer.zip"').send(b.zip);
  });

  r.post('/heartbeat', express.json({ limit: '64kb' }), (req, res) => {
    const st = players.heartbeat(req.player, req.body || {});
    res.json({ ok: true, received_at: st.received_at, current_layout_id: players.currentLayoutId(req.player) });
  });

  r.post('/thumbnail', express.raw({ type: ['image/jpeg', 'image/png'], limit: THUMB_MAX }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'send a JPEG body (Content-Type: image/jpeg)' });
    if (!thumbDir) return res.status(503).json({ error: 'no data dir' });
    fs.mkdirSync(thumbDir, { recursive: true });
    const ext = req.is('image/png') ? 'png' : 'jpg';
    const file = path.join(thumbDir, `${req.player.id}.${ext}`);
    fs.writeFileSync(`${file}.tmp`, req.body);
    fs.renameSync(`${file}.tmp`, file);
    db.prepare("UPDATE players SET thumbnail_path = ?, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(file, req.player.id);
    res.json({ ok: true, bytes: req.body.length });
  });

  return r;
}

module.exports = { createPlayerRouter, THUMB_MAX };
