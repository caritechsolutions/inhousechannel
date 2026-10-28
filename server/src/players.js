'use strict';
// Players: key issue/verify, the manifest a player syncs from, and heartbeat storage.
// The key is shown once at creation; only its sha256 is stored. Pairing on the box:
//   inhousechannel-player pair <server url> <key>
const crypto = require('crypto');
const { resolveLayout } = require('./schedule');
const { mediaRefs } = require('./layout');

const ONLINE_S = 180;
const RESOLUTIONS = ['1280x720', '1920x1080'];

function newKey() { return 'ihc_' + crypto.randomBytes(24).toString('base64url'); }
function hashKey(k) { return crypto.createHash('sha256').update(String(k)).digest('hex'); }
function pairCommand(baseUrl, key) { return `inhousechannel-player pair ${baseUrl} ${key}`; }
function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function createPlayers(db, { now = () => new Date() } = {}) {
  const qByHash = db.prepare('SELECT p.*, s.timezone AS site_tz, s.name AS site_name, s.logo_media_id FROM players p JOIN sites s ON s.id = p.site_id WHERE p.key_hash = ?');
  const qSchedules = db.prepare('SELECT * FROM schedules WHERE player_id = ? ORDER BY priority DESC, id');
  const qLayout = db.prepare('SELECT id, name, json, updated_at FROM layouts WHERE id = ? AND site_id = ?');
  const qMedia = db.prepare("SELECT id, kind, mime, size, sha256, name FROM media WHERE id = ? AND site_id = ? AND status = 'ready'");

  function byKey(key) { return key ? qByHash.get(hashKey(key)) || null : null; }
  function isOnline(p, at = now()) { return !!p.last_seen_at && (at.getTime() - new Date(p.last_seen_at).getTime()) / 1000 < ONLINE_S; }

  function create(siteId, { name, resolution }) {
    const key = newKey();
    const res = RESOLUTIONS.includes(resolution) ? resolution : '1280x720';
    const info = db.prepare('INSERT INTO players (site_id, name, key_hash, key_tail, resolution) VALUES (?, ?, ?, ?, ?)').run(siteId, name, hashKey(key), key.slice(-4), res);
    return { id: info.lastInsertRowid, key };
  }
  function rotateKey(playerId) {
    const key = newKey();
    db.prepare('UPDATE players SET key_hash = ?, key_tail = ? WHERE id = ?').run(hashKey(key), key.slice(-4), playerId);
    return key;
  }

  // Everything a player needs to run offline: its schedule, the layouts the schedule can
  // pick, and the ready media those layouts reference (+ the site logo as {{logo}}).
  function manifest(p) {
    const schedules = qSchedules.all(p.id);
    const layoutIds = new Set(schedules.map((s) => s.layout_id));
    if (p.default_layout_id) layoutIds.add(p.default_layout_id);
    const layouts = [], mediaIds = new Set();
    for (const id of layoutIds) {
      const l = qLayout.get(id, p.site_id);
      if (!l) continue;
      const json = safeJson(l.json);
      if (!json) continue;
      layouts.push({ id: l.id, name: l.name, json, updated_at: l.updated_at });
      for (const m of mediaRefs(json)) mediaIds.add(m);
    }
    if (p.logo_media_id) mediaIds.add(p.logo_media_id);
    const media = [];
    for (const id of [...mediaIds].sort((a, b) => a - b)) {
      const m = qMedia.get(id, p.site_id);
      if (m) media.push({ id: m.id, kind: m.kind, mime: m.mime, size: m.size, sha256: m.sha256, name: m.name, url: `/api/player/media/${m.id}` });
    }
    const ctx = { site: p.site_name, logo: p.logo_media_id ? `media:${p.logo_media_id}` : '' };
    return {
      player: { id: p.id, name: p.name, resolution: p.resolution, site_tz: p.site_tz, site: p.site_name },
      ctx,
      default_layout_id: p.default_layout_id || null,
      current_layout_id: resolveLayout({ default_layout_id: p.default_layout_id, schedules }, now(), p.site_tz),
      schedule: schedules.map((s) => ({ id: s.id, layout_id: s.layout_id, priority: s.priority, days_mask: s.days_mask, start_time: s.start_time, end_time: s.end_time, start_date: s.start_date, end_date: s.end_date, enabled: !!s.enabled })),
      layouts,
      media,
    };
  }
  // ETag covers content only (not the time-dependent current_layout_id), so an unchanged
  // schedule gives 304 all day; the player resolves the layout itself.
  function manifestEtag(m) {
    const { current_layout_id, ...rest } = m; // eslint-disable-line no-unused-vars
    return `"${crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 32)}"`;
  }

  const STATUS_KEYS = ['version', 'uptime_s', 'layout_id', 'page_id', 'cpu_pct', 'fps', 'bitrate_kbps', 'restarts_last_hour', 'cache_bytes', 'last_sync_at', 'resolution', 'output', 'errors'];
  function heartbeat(p, body) {
    const st = {};
    for (const k of STATUS_KEYS) if (body && body[k] !== undefined) st[k] = body[k];
    st.received_at = now().toISOString();
    db.prepare(`UPDATE players SET last_seen_at = ?, last_status_json = ?, version = COALESCE(?, version),
      output_json = COALESCE(?, output_json) WHERE id = ?`)
      .run(st.received_at, JSON.stringify(st), body && body.version != null ? String(body.version).slice(0, 40) : null,
        body && body.output && typeof body.output === 'object' ? JSON.stringify(body.output) : null, p.id);
    return st;
  }

  function currentLayoutId(p) { return resolveLayout({ default_layout_id: p.default_layout_id, schedules: qSchedules.all(p.id) }, now(), p.site_tz || 'UTC'); }

  function toApi(p, { layoutName = null } = {}) {
    return { id: p.id, site_id: p.site_id, name: p.name, key_tail: p.key_tail, resolution: p.resolution, default_layout_id: p.default_layout_id,
      version: p.version, last_seen_at: p.last_seen_at, online: isOnline(p), status: safeJson(p.last_status_json), output: safeJson(p.output_json),
      thumbnail_url: p.thumbnail_path ? `/api/admin/sites/${p.site_id}/players/${p.id}/thumbnail?t=${encodeURIComponent(p.last_seen_at || '')}` : null,
      current_layout_id: currentLayoutId(p), current_layout_name: layoutName, created_at: p.created_at };
  }

  return { byKey, create, rotateKey, manifest, manifestEtag, heartbeat, isOnline, toApi, currentLayoutId, RESOLUTIONS, ONLINE_S };
}

module.exports = { createPlayers, newKey, hashKey, pairCommand, RESOLUTIONS };
