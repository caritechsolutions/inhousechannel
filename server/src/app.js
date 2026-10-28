'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { openDb, migrate } = require('./db');
const { createAuth } = require('./auth');
const { createMediaStore } = require('./media');
const { createPlayers } = require('./players');
const { createRenderer } = require('./renderer');
const { createAdminRouter } = require('./routes/admin');
const { createPlayerRouter } = require('./routes/player');

// Builds the Express app + HTTP server. Tests call it with { memory: true, dataDir: <tmp> }.
function buildApp({ dbPath = null, memory = false, dataDir, adminDist = null, publicUrl = null, log = console.log, now = undefined } = {}) {
  if (!dataDir) throw new Error('dataDir required');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(memory ? ':memory:' : (dbPath || path.join(dataDir, 'inhousechannel.db')));
  const applied = migrate(db, log);
  if (applied) log(`database ready (${applied} migration(s) applied)`);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.set('etag', false);

  const auth = createAuth(db);
  const media = createMediaStore(db, dataDir, { log });
  const players = createPlayers(db, now ? { now } : {});
  const renderer = createRenderer();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, users: db.prepare('SELECT COUNT(*) n FROM users').get().n, sites: db.prepare('SELECT COUNT(*) n FROM sites').get().n,
      players: db.prepare('SELECT COUNT(*) n FROM players').get().n, time: new Date().toISOString() });
  });

  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api/player', createPlayerRouter({ db, players, media, renderer, dataDir, log }));
  app.use('/api/admin', createAdminRouter({ db, auth, players, media, publicUrl, log }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // Admin UI: the built Vite bundle when present (SPA fallback), a placeholder until then.
  app.get('/', (_req, res) => res.redirect('/admin/'));
  if (adminDist && fs.existsSync(path.join(adminDist, 'index.html'))) {
    app.use('/admin', express.static(adminDist, { index: 'index.html', maxAge: '1h', setHeaders(res, p) { if (p.endsWith('index.html')) res.set('Cache-Control', 'no-store'); } }));
    app.get('/admin/*', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(adminDist, 'index.html')); });
  } else {
    app.get(['/admin', '/admin/*'], (_req, res) => {
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>inhousechannel</title>
<body style="font-family:sans-serif;background:#0b1a2a;color:#f2f2f2;padding:40px"><h1>inhousechannel admin</h1>
<p>The admin UI bundle is not built. Run install.sh (it builds admin/). The API is up at /api/admin.</p></body>`);
    });
  }

  app.use((err, req, res, _next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    log(`ERROR ${req.method} ${req.originalUrl}: ${err.stack || err}`);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

  const server = http.createServer(app);
  return { app, server, db, auth, media, players, renderer, log };
}

module.exports = { buildApp };
