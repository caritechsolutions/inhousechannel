'use strict';
// Admin API. Login/logout are open; everything else needs a session. Access is by membership
// (auth.siteAccess): superadmins see every site, members see theirs. /sites/:site/* is
// site-scoped and 404s (not 403) for sites the caller cannot see, so site ids leak nothing.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');
const { createUser, normEmail, hashPassword, ROLE_RANK } = require('../auth');
const { validateLayout, layoutTemplates, templateLayout, blankLayout, ZONE_TYPES } = require('../layout');
const { validateSchedule } = require('../schedule');
const { pairCommand, RESOLUTIONS } = require('../players');

function safe(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function slugify(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
function nowIso() { return new Date().toISOString(); }

function createAdminRouter({ db, auth, players, media, publicUrl = null, log = () => {} }) {
  const r = express.Router();
  const json = express.json({ limit: '2mb' });

  // ---------------------------------------------------------------- auth
  r.post('/login', json, (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const out = auth.login({ email, password, ip: req.ip });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.set('Set-Cookie', auth.cookieHeader(out.sessionId, out.expires));
    log(`admin login ${out.user.email}${out.user.is_superadmin ? ' (superadmin)' : ''} from ${req.ip}`);
    res.json({ user: out.user, sites: auth.memberships(out.user) });
  });
  r.post('/logout', (req, res) => {
    const row = auth.sessionFromRequest(req);
    if (row) auth.logout(row.session_id);
    res.set('Set-Cookie', auth.clearCookie);
    res.json({ ok: true });
  });

  r.use(auth.requireAuth);
  r.get('/me', (req, res) => res.json({ user: req.user, sites: visibleSites(req.user) }));

  // Sites the caller can see, with their role.
  const qAllSites = db.prepare('SELECT * FROM sites ORDER BY name');
  const qMySites = db.prepare('SELECT s.*, m.role FROM sites s JOIN memberships m ON m.site_id = s.id WHERE m.user_id = ? ORDER BY s.name');
  function siteToApi(s, role) {
    return { id: s.id, name: s.name, slug: s.slug, timezone: s.timezone, logo_media_id: s.logo_media_id, settings: safe(s.settings_json) || {}, role, created_at: s.created_at };
  }
  function visibleSites(user) {
    return user.is_superadmin ? qAllSites.all().map((s) => siteToApi(s, 'admin')) : qMySites.all(user.id).map((s) => siteToApi(s, s.role));
  }

  r.get('/layout-templates', (_req, res) => res.json(layoutTemplates()));
  r.get('/zone-types', (_req, res) => res.json(ZONE_TYPES));

  // ---------------------------------------------------------------- dashboard
  const qSitePlayers = db.prepare('SELECT p.*, s.timezone AS site_tz FROM players p JOIN sites s ON s.id = p.site_id WHERE p.site_id = ? ORDER BY p.name');
  const qLayoutName = db.prepare('SELECT name FROM layouts WHERE id = ?');
  function playerApi(p) {
    const lid = players.currentLayoutId(p);
    const l = lid ? qLayoutName.get(lid) : null;
    return players.toApi(p, { layoutName: l ? l.name : null });
  }
  r.get('/dashboard', (req, res) => {
    const sites = visibleSites(req.user).map((s) => {
      const ps = qSitePlayers.all(s.id).map(playerApi);
      return { ...s, players: ps, counts: { players: ps.length, online: ps.filter((p) => p.online).length,
        layouts: db.prepare('SELECT COUNT(*) n FROM layouts WHERE site_id = ?').get(s.id).n,
        media: db.prepare('SELECT COUNT(*) n FROM media WHERE site_id = ?').get(s.id).n } };
    });
    res.json({ sites, time: nowIso() });
  });

  // ---------------------------------------------------------------- sites (superadmin)
  r.get('/sites', (req, res) => res.json(visibleSites(req.user)));
  r.post('/sites', json, auth.requireSuperadmin, (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'name required' });
    let slug = slugify(b.slug || name);
    if (!slug) return res.status(400).json({ error: 'slug required' });
    if (db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(slug)) return res.status(409).json({ error: 'slug already in use' });
    const tz = validTz(b.timezone) || 'America/Barbados';
    const id = db.prepare('INSERT INTO sites (name, slug, timezone) VALUES (?, ?, ?)').run(name, slug, tz).lastInsertRowid;
    log(`site created: ${name} (${slug}) by ${req.user.email}`);
    res.status(201).json(siteToApi(db.prepare('SELECT * FROM sites WHERE id = ?').get(id), 'admin'));
  });

  // ---------------------------------------------------------------- users (superadmin)
  const userCols = 'id, email, is_superadmin, created_at, last_login';
  const qUserMemberships = db.prepare('SELECT m.site_id, m.role, s.name AS site_name FROM memberships m JOIN sites s ON s.id = m.site_id WHERE m.user_id = ? ORDER BY s.name');
  const userApi = (u) => ({ ...u, is_superadmin: !!u.is_superadmin, memberships: qUserMemberships.all(u.id) });
  r.get('/users', auth.requireSuperadmin, (_req, res) => res.json(db.prepare(`SELECT ${userCols} FROM users ORDER BY email`).all().map(userApi)));
  r.post('/users', json, auth.requireSuperadmin, (req, res) => {
    const b = req.body || {};
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(normEmail(b.email))) return res.status(409).json({ error: 'email already registered' });
    let u;
    try { u = createUser(db, { email: b.email, password: b.password, is_superadmin: !!b.is_superadmin }); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    log(`user created: ${u.email} by ${req.user.email}`);
    res.status(201).json(userApi(u));
  });
  r.patch('/users/:id', json, auth.requireSuperadmin, (req, res) => {
    const u = db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'user not found' });
    const b = req.body || {};
    if (b.is_superadmin !== undefined) {
      if (u.id === req.user.id && !b.is_superadmin) return res.status(400).json({ error: 'cannot remove your own superadmin flag' });
      db.prepare('UPDATE users SET is_superadmin = ? WHERE id = ?').run(b.is_superadmin ? 1 : 0, u.id);
    }
    if (b.email !== undefined) {
      const em = normEmail(b.email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'invalid email' });
      if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(em, u.id)) return res.status(409).json({ error: 'email already registered' });
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(em, u.id);
    }
    if (b.password !== undefined) {
      if (String(b.password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
      if (u.id !== req.user.id) auth.logoutUser(u.id);
    }
    res.json(userApi(db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(u.id)));
  });
  r.delete('/users/:id', auth.requireSuperadmin, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
    const n = db.prepare('DELETE FROM users WHERE id = ?').run(id).changes;
    if (!n) return res.status(404).json({ error: 'user not found' });
    res.json({ ok: true });
  });
  // Anyone may change their own password.
  r.post('/me/password', json, (req, res) => {
    const { current, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const { verifyPassword } = require('../auth');
    if (!verifyPassword(current, u.password_hash)) return res.status(400).json({ error: 'current password is wrong' });
    if (String(password || '').length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- site-scoped
  const site = express.Router({ mergeParams: true });
  r.use('/sites/:site', (req, res, next) => {
    const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.site));
    if (!s || !auth.siteAccess(req, s.id, 'editor')) return res.status(404).json({ error: 'site not found' });
    req.site = s;
    req.siteRole = auth.roleOn(req.user, s.id);
    next();
  }, site);
  const requireSiteAdmin = (req, res, next) => (ROLE_RANK[req.siteRole] >= ROLE_RANK.admin ? next() : res.status(403).json({ error: 'site admin only' }));

  site.get('/', (req, res) => res.json(siteToApi(req.site, req.siteRole)));
  site.patch('/', json, requireSiteAdmin, (req, res) => {
    const b = req.body || {};
    const upd = {};
    if (b.name !== undefined) { upd.name = String(b.name).trim().slice(0, 80); if (!upd.name) return res.status(400).json({ error: 'name required' }); }
    if (b.timezone !== undefined) { upd.timezone = validTz(b.timezone); if (!upd.timezone) return res.status(400).json({ error: 'unknown timezone' }); }
    if (b.logo_media_id !== undefined) {
      if (b.logo_media_id != null) { const m = media.getRow(req.site.id, b.logo_media_id); if (!m || m.kind !== 'image') return res.status(400).json({ error: 'logo must be an image of this site' }); }
      upd.logo_media_id = b.logo_media_id == null ? null : Number(b.logo_media_id);
    }
    if (b.settings !== undefined && typeof b.settings === 'object') upd.settings_json = JSON.stringify(b.settings);
    if (b.slug !== undefined && req.user.is_superadmin) {
      upd.slug = slugify(b.slug); if (!upd.slug) return res.status(400).json({ error: 'slug required' });
      if (db.prepare('SELECT 1 FROM sites WHERE slug = ? AND id != ?').get(upd.slug, req.site.id)) return res.status(409).json({ error: 'slug already in use' });
    }
    const keys = Object.keys(upd);
    if (keys.length) db.prepare(`UPDATE sites SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => upd[k]), req.site.id);
    res.json(siteToApi(db.prepare('SELECT * FROM sites WHERE id = ?').get(req.site.id), req.siteRole));
  });
  site.delete('/', auth.requireSuperadmin, (req, res) => {
    const dir = path.join(media.mediaDir, String(req.site.id));
    db.prepare('DELETE FROM sites WHERE id = ?').run(req.site.id);
    fs.rmSync(dir, { recursive: true, force: true });
    log(`site deleted: ${req.site.name} by ${req.user.email}`);
    res.json({ ok: true });
  });

  // members: site admins manage who sees the site (and may create the user on the spot).
  const qMembers = db.prepare('SELECT u.id, u.email, u.is_superadmin, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = ? ORDER BY u.email');
  site.get('/members', requireSiteAdmin, (req, res) => res.json(qMembers.all(req.site.id).map((u) => ({ ...u, is_superadmin: !!u.is_superadmin }))));
  site.put('/members', json, requireSiteAdmin, (req, res) => {
    const b = req.body || {};
    const role = b.role === 'admin' ? 'admin' : b.role === 'editor' ? 'editor' : null;
    if (!role) return res.status(400).json({ error: 'role must be admin or editor' });
    let u = b.user_id ? db.prepare('SELECT id, email FROM users WHERE id = ?').get(Number(b.user_id)) : db.prepare('SELECT id, email FROM users WHERE email = ?').get(normEmail(b.email));
    if (!u) {
      if (!b.email || !b.password) return res.status(404).json({ error: 'user not found (send email + password to create one)' });
      try { u = createUser(db, { email: b.email, password: b.password }); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
      log(`user created: ${u.email} by ${req.user.email} for site ${req.site.slug}`);
    }
    db.prepare('INSERT INTO memberships (user_id, site_id, role) VALUES (?, ?, ?) ON CONFLICT(user_id, site_id) DO UPDATE SET role = excluded.role').run(u.id, req.site.id, role);
    res.json(qMembers.all(req.site.id).map((m) => ({ ...m, is_superadmin: !!m.is_superadmin })));
  });
  site.delete('/members/:user', requireSiteAdmin, (req, res) => {
    db.prepare('DELETE FROM memberships WHERE site_id = ? AND user_id = ?').run(req.site.id, Number(req.params.user));
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- players
  const qPlayer = db.prepare('SELECT p.*, s.timezone AS site_tz FROM players p JOIN sites s ON s.id = p.site_id WHERE p.id = ? AND p.site_id = ?');
  const qLayout = db.prepare('SELECT * FROM layouts WHERE id = ? AND site_id = ?');
  function loadPlayer(req, res) {
    const p = qPlayer.get(Number(req.params.id), req.site.id);
    if (!p) { res.status(404).json({ error: 'player not found' }); return null; }
    return p;
  }
  function baseUrl(req) {
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  }
  site.get('/players', (req, res) => res.json(qSitePlayers.all(req.site.id).map(playerApi)));
  site.post('/players', json, (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'name required' });
    if (b.resolution !== undefined && !RESOLUTIONS.includes(b.resolution)) return res.status(400).json({ error: `resolution must be one of ${RESOLUTIONS.join(', ')}` });
    if (b.default_layout_id != null && !qLayout.get(Number(b.default_layout_id), req.site.id)) return res.status(400).json({ error: 'unknown layout' });
    const { id, key } = players.create(req.site.id, { name, resolution: b.resolution });
    if (b.default_layout_id != null) db.prepare('UPDATE players SET default_layout_id = ? WHERE id = ?').run(Number(b.default_layout_id), id);
    log(`player created: ${name} in ${req.site.slug} by ${req.user.email}`);
    res.status(201).json({ ...playerApi(qPlayer.get(id, req.site.id)), key, pair: pairCommand(baseUrl(req), key) });
  });
  site.get('/players/:id', (req, res) => {
    const p = loadPlayer(req, res); if (!p) return;
    res.json({ ...playerApi(p), schedules: db.prepare('SELECT * FROM schedules WHERE player_id = ? ORDER BY priority DESC, id').all(p.id).map(schedApi) });
  });
  site.patch('/players/:id', json, (req, res) => {
    const p = loadPlayer(req, res); if (!p) return;
    const b = req.body || {};
    const upd = {};
    if (b.name !== undefined) { upd.name = String(b.name).trim().slice(0, 80); if (!upd.name) return res.status(400).json({ error: 'name required' }); }
    if (b.resolution !== undefined) { if (!RESOLUTIONS.includes(b.resolution)) return res.status(400).json({ error: `resolution must be one of ${RESOLUTIONS.join(', ')}` }); upd.resolution = b.resolution; }
    if (b.default_layout_id !== undefined) {
      if (b.default_layout_id != null && !qLayout.get(Number(b.default_layout_id), req.site.id)) return res.status(400).json({ error: 'unknown layout' });
      upd.default_layout_id = b.default_layout_id == null ? null : Number(b.default_layout_id);
    }
    const keys = Object.keys(upd);
    if (keys.length) db.prepare(`UPDATE players SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => upd[k]), p.id);
    res.json(playerApi(qPlayer.get(p.id, req.site.id)));
  });
  site.post('/players/:id/rotate-key', (req, res) => {
    const p = loadPlayer(req, res); if (!p) return;
    const key = players.rotateKey(p.id);
    log(`player key rotated: ${p.name} by ${req.user.email}`);
    res.json({ ...playerApi(qPlayer.get(p.id, req.site.id)), key, pair: pairCommand(baseUrl(req), key) });
  });
  site.delete('/players/:id', requireSiteAdmin, (req, res) => {
    const p = loadPlayer(req, res); if (!p) return;
    db.prepare('DELETE FROM players WHERE id = ?').run(p.id);
    if (p.thumbnail_path) try { fs.unlinkSync(p.thumbnail_path); } catch { /* gone */ }
    res.json({ ok: true });
  });
  site.get('/players/:id/thumbnail', (req, res) => {
    const p = loadPlayer(req, res); if (!p) return;
    if (!p.thumbnail_path || !fs.existsSync(p.thumbnail_path)) return res.status(404).json({ error: 'no thumbnail yet' });
    res.set('Cache-Control', 'no-store').sendFile(p.thumbnail_path);
  });

  // ---------------------------------------------------------------- schedules
  function schedApi(s) { return { ...s, enabled: !!s.enabled }; }
  site.get('/players/:id/schedules', (req, res) => {
    const p = loadPlayer(req, res); if (!p) return;
    res.json(db.prepare('SELECT * FROM schedules WHERE player_id = ? ORDER BY priority DESC, id').all(p.id).map(schedApi));
  });
  site.post('/players/:id/schedules', json, (req, res) => {
    const p = loadPlayer(req, res); if (!p) return;
    const { schedule: s, errors } = validateSchedule(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    if (!qLayout.get(s.layout_id, req.site.id)) return res.status(400).json({ error: 'unknown layout' });
    const id = db.prepare(`INSERT INTO schedules (player_id, layout_id, priority, days_mask, start_time, end_time, start_date, end_date, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, s.layout_id, s.priority, s.days_mask, s.start_time, s.end_time, s.start_date, s.end_date, s.enabled).lastInsertRowid;
    res.status(201).json(schedApi(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id)));
  });
  site.put('/players/:id/schedules/:sid', json, (req, res) => {
    const p = loadPlayer(req, res); if (!p) return;
    const cur = db.prepare('SELECT * FROM schedules WHERE id = ? AND player_id = ?').get(Number(req.params.sid), p.id);
    if (!cur) return res.status(404).json({ error: 'schedule not found' });
    const { schedule: s, errors } = validateSchedule({ ...cur, enabled: !!cur.enabled, ...(req.body || {}) });
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    if (!qLayout.get(s.layout_id, req.site.id)) return res.status(400).json({ error: 'unknown layout' });
    db.prepare('UPDATE schedules SET layout_id = ?, priority = ?, days_mask = ?, start_time = ?, end_time = ?, start_date = ?, end_date = ?, enabled = ? WHERE id = ?')
      .run(s.layout_id, s.priority, s.days_mask, s.start_time, s.end_time, s.start_date, s.end_date, s.enabled, cur.id);
    res.json(schedApi(db.prepare('SELECT * FROM schedules WHERE id = ?').get(cur.id)));
  });
  site.delete('/players/:id/schedules/:sid', (req, res) => {
    const p = loadPlayer(req, res); if (!p) return;
    const n = db.prepare('DELETE FROM schedules WHERE id = ? AND player_id = ?').run(Number(req.params.sid), p.id).changes;
    if (!n) return res.status(404).json({ error: 'schedule not found' });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- layouts
  const qLayouts = db.prepare('SELECT id, site_id, name, json, created_at, updated_at FROM layouts WHERE site_id = ? ORDER BY name');
  const layoutApi = (l) => ({ ...l, json: safe(l.json) });
  function playersUsing(layoutId) {
    return db.prepare(`SELECT DISTINCT p.id, p.name FROM players p LEFT JOIN schedules s ON s.player_id = p.id
      WHERE p.default_layout_id = ? OR s.layout_id = ? ORDER BY p.name`).all(layoutId, layoutId);
  }
  site.get('/layouts', (req, res) => res.json(qLayouts.all(req.site.id).map(layoutApi)));
  site.get('/layouts/:id', (req, res) => {
    const l = qLayout.get(Number(req.params.id), req.site.id);
    if (!l) return res.status(404).json({ error: 'layout not found' });
    res.json({ ...layoutApi(l), players: playersUsing(l.id) });
  });
  site.post('/layouts/validate', json, (req, res) => { const { doc, errors } = validateLayout(req.body); res.json({ ok: !errors.length, errors, doc }); });
  site.post('/layouts', json, (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80) || 'New layout';
    let input = b.json;
    if (!input) input = b.template ? templateLayout(b.template, name) : blankLayout(name);
    if (!input) return res.status(400).json({ error: 'unknown template' });
    const { doc, errors } = validateLayout({ ...input, name });
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    const id = db.prepare('INSERT INTO layouts (site_id, name, json) VALUES (?, ?, ?)').run(req.site.id, name, JSON.stringify(doc)).lastInsertRowid;
    res.status(201).json(layoutApi(qLayout.get(id, req.site.id)));
  });
  site.put('/layouts/:id', json, (req, res) => {
    const l = qLayout.get(Number(req.params.id), req.site.id);
    if (!l) return res.status(404).json({ error: 'layout not found' });
    const b = req.body || {};
    const input = b.json || b;
    const name = String(b.name || input.name || l.name).trim().slice(0, 80) || l.name;
    const { doc, errors } = validateLayout({ ...input, name });
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    db.prepare("UPDATE layouts SET name = ?, json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(name, JSON.stringify(doc), l.id);
    res.json({ ...layoutApi(qLayout.get(l.id, req.site.id)), players: playersUsing(l.id) });
  });
  site.post('/layouts/:id/duplicate', (req, res) => {
    const l = qLayout.get(Number(req.params.id), req.site.id);
    if (!l) return res.status(404).json({ error: 'layout not found' });
    let name = `${l.name} copy`, i = 2;
    while (db.prepare('SELECT 1 FROM layouts WHERE site_id = ? AND name = ?').get(req.site.id, name)) name = `${l.name} copy ${i++}`;
    const doc = { ...safe(l.json), name };
    const id = db.prepare('INSERT INTO layouts (site_id, name, json) VALUES (?, ?, ?)').run(req.site.id, name, JSON.stringify(doc)).lastInsertRowid;
    res.status(201).json(layoutApi(qLayout.get(id, req.site.id)));
  });
  site.delete('/layouts/:id', (req, res) => {
    const l = qLayout.get(Number(req.params.id), req.site.id);
    if (!l) return res.status(404).json({ error: 'layout not found' });
    const used = playersUsing(l.id);
    if (used.length && !req.query.force) return res.status(409).json({ error: 'layout is in use', players: used });
    db.prepare('DELETE FROM layouts WHERE id = ?').run(l.id);   // schedules cascade, default_layout_id → NULL
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- media
  site.get('/media', (req, res) => res.json(media.list(req.site.id)));
  site.get('/media/:id', (req, res) => { const m = media.get(req.site.id, req.params.id); m ? res.json(m) : res.status(404).json({ error: 'media not found' }); });
  site.get('/media/:id/file', (req, res) => {
    const row = media.getRow(req.site.id, req.params.id);
    if (!row) return res.status(404).json({ error: 'media not found' });
    const f = req.query.original ? row.original_path : media.filePath(row);
    res.set('Cache-Control', 'private, max-age=3600').sendFile(f, { headers: { 'Content-Type': req.query.original ? 'application/octet-stream' : row.mime } });
  });
  site.get('/media/:id/thumb', (req, res) => {
    const row = media.getRow(req.site.id, req.params.id);
    if (!row || !fs.existsSync(media.thumbPath(row))) return res.status(404).json({ error: 'no thumbnail' });
    res.set('Cache-Control', 'private, max-age=86400').sendFile(media.thumbPath(row));
  });
  // Upload: multipart (field "file", optional "name") or a raw body with X-Filename. Streamed
  // to a temp file while hashing; the first 512 bytes decide the type.
  site.post('/media', (req, res) => {
    const tmp = path.join(media.tmpDir, `${crypto.randomUUID()}.upload`);
    const h = crypto.createHash('sha256');
    let head = Buffer.alloc(0), size = 0, name = null, done = false;
    const out = fs.createWriteStream(tmp);
    const onChunk = (c) => { h.update(c); size += c.length; if (head.length < 512) head = Buffer.concat([head, c]).slice(0, 512); };
    const finish = async () => {
      if (done) return; done = true;
      try {
        if (!size) { fs.unlinkSync(tmp); return res.status(400).json({ error: 'empty upload' }); }
        if (size > media.MAX_BYTES) { fs.unlinkSync(tmp); return res.status(413).json({ error: 'file too large' }); }
        const m = await media.save(req.site.id, { tmpPath: tmp, name, head, size, sha256: h.digest('hex') });
        log(`media uploaded: ${m.name} (${m.kind}, ${size} bytes${m.status === 'processing' ? ', normalising' : ''}) to ${req.site.slug} by ${req.user.email}`);
        res.status(201).json(m);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* gone */ }
        res.status(e.status || 500).json({ error: e.message });
      }
    };
    const abort = (msg) => { if (done) return; done = true; out.destroy(); try { fs.unlinkSync(tmp); } catch { /* none */ } res.status(400).json({ error: msg }); };
    if (req.is('multipart/form-data')) {
      let bb;
      try { bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: media.MAX_BYTES } }); } catch (e) { return abort(e.message); }
      bb.on('field', (k, v) => { if (k === 'name') name = v; });
      bb.on('file', (_field, stream, info) => {
        if (!name) name = info.filename || null;
        stream.on('data', onChunk);
        stream.on('limit', () => abort('file too large'));
        stream.pipe(out, { end: false });
        stream.on('end', () => { out.end(); });
      });
      bb.on('error', (e) => abort(e.message));
      bb.on('finish', () => { if (!out.writableEnded) out.end(); });
      out.on('finish', finish);
      req.pipe(bb);
    } else {
      if (req.headers['x-filename']) { try { name = decodeURIComponent(String(req.headers['x-filename'])); } catch { name = String(req.headers['x-filename']); } }
      req.on('data', onChunk);
      req.pipe(out);
      out.on('finish', finish);
    }
    out.on('error', (e) => abort(e.message));
  });
  site.patch('/media/:id', json, (req, res) => {
    try { const m = media.rename(req.site.id, req.params.id, (req.body || {}).name); m ? res.json(m) : res.status(404).json({ error: 'media not found' }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  site.post('/media/:id/retry', (req, res) => { const m = media.retry(req.site.id, req.params.id); m ? res.json(m) : res.status(404).json({ error: 'no failed media with that id' }); });
  site.get('/media/:id/references', (req, res) => res.json(media.references(req.site.id, req.params.id)));
  site.delete('/media/:id', (req, res) => {
    const out = media.remove(req.site.id, req.params.id, { force: !!req.query.force });
    if (!out.ok) return res.status(out.status).json(out);
    res.json(out);
  });

  return r;
}

function validTz(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

module.exports = { createAdminRouter };
