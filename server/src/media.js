'use strict';
// Per-site media library. Uploads are streamed to <dataDir>/media/<site>/<uuid>.<ext> (the
// type comes from the magic bytes, never the file name), hashed on the way in, and:
//   image → sharp thumbnail at <dataDir>/thumbs/<uuid>.jpg + width/height, ready at once
//   font  → ready at once
//   video → queued: ffmpeg normalises to the player profile (CLAUDE.md §3.4) → <uuid>.norm.mp4
//   audio → queued: ffmpeg → AAC 48 kHz stereo <uuid>.norm.m4a
// `path` is what players download; `original_path` is kept. One ffmpeg job runs at a time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const THUMB_PX = 320;
const TYPES = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  webm: { kind: 'video', mime: 'video/webm' },
  avi: { kind: 'video', mime: 'video/x-msvideo' },
  ts: { kind: 'video', mime: 'video/mp2t' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  ttf: { kind: 'font', mime: 'font/ttf' },
  otf: { kind: 'font', mime: 'font/otf' },
  woff: { kind: 'font', mime: 'font/woff' },
  woff2: { kind: 'font', mime: 'font/woff2' },
};
const NORMALISED_MIME = { video: 'video/mp4', audio: 'audio/mp4' };

let sharpMod;
function loadSharp() {
  if (sharpMod !== undefined) return sharpMod;
  try { sharpMod = require('sharp'); } catch { sharpMod = null; }
  return sharpMod;
}

// Sniff the magic bytes so a renamed executable cannot land in the library.
function sniffExt(buf) {
  if (!buf || buf.length < 12) return null;
  const a = (o, s) => buf.slice(o, o + s.length).toString('latin1') === s;
  if (buf[0] === 0x89 && a(1, 'PNG')) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (a(0, 'GIF8')) return 'gif';
  if (a(0, 'RIFF') && a(8, 'WEBP')) return 'webp';
  if (a(0, 'RIFF') && a(8, 'WAVE')) return 'wav';
  if (a(0, 'RIFF') && a(8, 'AVI ')) return 'avi';
  if (a(4, 'ftyp')) {
    const brand = buf.slice(8, 12).toString('latin1');
    if (brand === 'M4A ' || brand === 'M4B ') return 'm4a';
    if (brand.startsWith('qt')) return 'mov';
    return 'mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return buf.slice(0, 64).toString('latin1').includes('webm') ? 'webm' : 'mkv';
  }
  if (buf[0] === 0x47 && buf.length > 188 && buf[188] === 0x47) return 'ts';
  if (a(0, 'ID3') || (buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2)) return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'aac';
  if (a(0, 'OggS')) return 'ogg';
  if (a(0, 'fLaC')) return 'flac';
  if (a(0, 'wOF2')) return 'woff2';
  if (a(0, 'wOFF')) return 'woff';
  if (a(0, 'OTTO')) return 'otf';
  if (buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0) return 'ttf';
  if (a(0, 'true')) return 'ttf';
  const head = buf.slice(0, 512).toString('utf8').replace(/^﻿/, '').replace(/^\s+/, '');
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

function cleanName(s, fallback) {
  const v = String(s == null ? '' : s).trim().replace(/[\x00-\x1f]/g, '').slice(0, 120);
  return v || fallback;
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
function run(cmd, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let err = '', out = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; if (err.length > 20000) err = err.slice(-10000); });
    let t = null;
    if (timeoutMs) t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    p.on('error', (e) => { if (t) clearTimeout(t); resolve({ code: -1, out, err: String(e.message) }); });
    p.on('close', (code) => { if (t) clearTimeout(t); resolve({ code, out, err }); });
  });
}
function haveFfmpeg() {
  for (const d of (process.env.PATH || '').split(':')) { try { fs.accessSync(path.join(d, 'ffmpeg'), fs.constants.X_OK); return true; } catch { /* next */ } }
  return false;
}

function createMediaStore(db, dataDir, { log = () => {}, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', now = () => new Date() } = {}) {
  const mediaDir = path.join(dataDir, 'media');
  const thumbDir = path.join(dataDir, 'thumbs');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(thumbDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const siteDir = (siteId) => path.join(mediaDir, String(siteId));
  const uuidOf = (row) => path.basename(row.original_path).split('.')[0];
  const thumbPath = (row) => path.join(thumbDir, `${uuidOf(row)}.jpg`);

  function toApi(row) {
    return { id: row.id, site_id: row.site_id, kind: row.kind, name: row.name, mime: row.mime, size: row.size, width: row.width, height: row.height,
      duration_s: row.duration_s, sha256: row.sha256, status: row.status, error: row.error, created_at: row.created_at,
      ref: `media:${row.id}`, url: `/api/admin/sites/${row.site_id}/media/${row.id}/file`,
      thumb_url: row.kind === 'image' && fs.existsSync(thumbPath(row)) ? `/api/admin/sites/${row.site_id}/media/${row.id}/thumb` : null };
  }
  const qList = db.prepare('SELECT * FROM media WHERE site_id = ? ORDER BY created_at DESC, id DESC');
  const qGet = db.prepare('SELECT * FROM media WHERE id = ? AND site_id = ?');
  function list(siteId) { return qList.all(siteId).map(toApi); }
  function getRow(siteId, id) { return qGet.get(Number(id), siteId) || null; }
  function get(siteId, id) { const r = getRow(siteId, id); return r ? toApi(r) : null; }
  function filePath(row) { return row.path || row.original_path; }

  async function probeImage(file, row) {
    const sharp = loadSharp();
    if (!sharp) { log('media: sharp is not installed, no thumbnails'); return {}; }
    try {
      const img = sharp(file, { failOn: 'none' });
      const meta = await img.metadata();
      await sharp(file).resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#0b1a2a' }).jpeg({ quality: 80 }).toFile(thumbPath(row));
      return { width: meta.width || null, height: meta.height || null };
    } catch (e) { log(`media: sharp could not read ${file}: ${e.message}`); return {}; }
  }

  // Register an upload that is already on disk at tmpPath (routes stream it there). Moves it
  // into place, inserts the row and queues normalisation when needed. Returns the API row.
  async function save(siteId, { tmpPath, name, head, size, sha256 }) {
    const ext = sniffExt(head);
    if (!ext) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } throw badRequest('unsupported file type (image, video, audio or font)'); }
    const type = TYPES[ext];
    const uuid = crypto.randomUUID();
    fs.mkdirSync(siteDir(siteId), { recursive: true });
    const dest = path.join(siteDir(siteId), `${uuid}.${ext}`);
    fs.renameSync(tmpPath, dest);
    const display = cleanName(name ? String(name).replace(/\.[a-z0-9]+$/i, '') : '', `${type.kind}-${uuid.slice(0, 8)}`);
    const needsWork = type.kind === 'video' || type.kind === 'audio';
    const row = { original_path: dest };
    const dims = type.kind === 'image' ? await probeImage(dest, row) : {};
    const info = db.prepare(`INSERT INTO media (site_id, kind, name, original_path, path, mime, size, width, height, sha256, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(siteId, type.kind, display, dest, needsWork ? null : dest, type.mime, size, dims.width || null, dims.height || null, needsWork ? null : sha256, needsWork ? 'processing' : 'ready');
    const id = info.lastInsertRowid;
    if (needsWork) enqueue(id);
    return get(siteId, id);
  }

  // ---------------------------------------------------------------- normalisation queue
  const queue = [];
  let running = null, stopped = false;
  function enqueue(id) { if (!queue.includes(id)) queue.push(id); kick(); }
  function kick() { if (!running && !stopped && queue.length) { running = work(queue.shift()).catch((e) => log(`media: job crashed: ${e.stack || e}`)).then(() => { running = null; kick(); }); } }
  function drain() { return running ? running.then(drain) : Promise.resolve(); }
  function stop() { stopped = true; }

  async function probeAv(file) {
    const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file], { timeoutMs: 60000 });
    if (r.code !== 0) return null;
    try {
      const j = JSON.parse(r.out);
      const v = (j.streams || []).find((s) => s.codec_type === 'video'), a = (j.streams || []).find((s) => s.codec_type === 'audio');
      return { hasVideo: !!v, hasAudio: !!a, width: v ? v.width : null, height: v ? v.height : null, duration: Number(j.format && j.format.duration) || null };
    } catch { return null; }
  }
  // CLAUDE.md §3.4: H.264 High 1280×720 30 fps CFR, GOP 60, ≤ 6 Mb/s, AAC 48 kHz stereo,
  // +faststart. A silent track is synthesised when the source has none (players expect audio).
  function videoArgs(src, dst, info) {
    const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', src];
    if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest');
    args.push('-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-level', '4.0', '-crf', '20', '-maxrate', '6M', '-bufsize', '12M',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', dst);
    return args;
  }
  function audioArgs(src, dst) {
    return ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', dst];
  }
  async function work(id) {
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
    if (!row || row.status !== 'processing') return;
    const fail = (msg) => { log(`media ${id} (${row.name}): normalisation failed: ${msg.split('\n').slice(-3).join(' | ')}`); db.prepare("UPDATE media SET status = 'failed', error = ? WHERE id = ?").run(msg.slice(-2000), id); };
    const info = await probeAv(row.original_path);
    if (!info) return fail('ffprobe could not read the file (is ffmpeg installed?)');
    if (row.kind === 'video' && !info.hasVideo) return fail('no video stream');
    if (row.kind === 'audio' && !info.hasAudio) return fail('no audio stream');
    const dst = path.join(siteDir(row.site_id), `${uuidOf(row)}.norm.${row.kind === 'video' ? 'mp4' : 'm4a'}`);
    const tmp = `${dst}.part.mp4`;
    log(`media ${id} (${row.name}): normalising ${row.kind} ${info.width || ''}${info.height ? 'x' + info.height : ''} ${info.duration ? Math.round(info.duration) + 's' : ''}`);
    const t0 = Date.now();
    const r = await run(ffmpeg, row.kind === 'video' ? videoArgs(row.original_path, tmp, info) : audioArgs(row.original_path, tmp), { timeoutMs: 4 * 3600 * 1000 });
    if (r.code !== 0) { try { fs.unlinkSync(tmp); } catch { /* none */ } return fail(r.err || `ffmpeg exit ${r.code}`); }
    fs.renameSync(tmp, dst);
    const out = await probeAv(dst);
    const sha = await sha256File(dst);
    db.prepare("UPDATE media SET path = ?, mime = ?, size = ?, width = ?, height = ?, duration_s = ?, sha256 = ?, status = 'ready', error = NULL WHERE id = ?")
      .run(dst, NORMALISED_MIME[row.kind], fs.statSync(dst).size, out && out.width || null, out && out.height || null, (out && out.duration) || info.duration, sha, id);
    log(`media ${id} (${row.name}): ready in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  // Startup: anything left 'processing' by a crash goes back on the queue.
  for (const r of db.prepare("SELECT id FROM media WHERE status = 'processing' ORDER BY id").all()) enqueue(r.id);

  function retry(siteId, id) {
    const row = getRow(siteId, id);
    if (!row || row.status !== 'failed') return null;
    db.prepare("UPDATE media SET status = 'processing', error = NULL WHERE id = ?").run(row.id);
    enqueue(row.id);
    return get(siteId, row.id);
  }
  function rename(siteId, id, name) {
    const row = getRow(siteId, id);
    if (!row) return null;
    const v = cleanName(name, '');
    if (!v) throw badRequest('name required');
    db.prepare('UPDATE media SET name = ? WHERE id = ?').run(v, row.id);
    return get(siteId, row.id);
  }
  // Layouts of the site referencing this item (by `media:<id>` token) and whether it is the logo.
  function references(siteId, id) {
    const needle = `media:${Number(id)}`;
    const layouts = db.prepare('SELECT id, name FROM layouts WHERE site_id = ? AND instr(json, ?) > 0 ORDER BY name').all(siteId, needle)
      .filter((l) => new RegExp(`${needle}(?!\\d)`).test(db.prepare('SELECT json FROM layouts WHERE id = ?').get(l.id).json));
    const site = db.prepare('SELECT logo_media_id FROM sites WHERE id = ?').get(siteId);
    return { layouts, logo: !!site && site.logo_media_id === Number(id) };
  }
  function remove(siteId, id, { force = false } = {}) {
    const row = getRow(siteId, id);
    if (!row) return { ok: false, status: 404, error: 'media not found' };
    const refs = references(siteId, id);
    if (!force && (refs.layouts.length || refs.logo)) return { ok: false, status: 409, error: 'media is in use', ...refs };
    if (refs.logo) db.prepare('UPDATE sites SET logo_media_id = NULL WHERE id = ?').run(siteId);
    db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
    for (const f of [row.original_path, row.path, thumbPath(row)]) { if (f) try { fs.unlinkSync(f); } catch { /* gone already */ } }
    return { ok: true, ...refs };
  }

  return { list, get, getRow, save, rename, remove, retry, references, filePath, thumbPath, toApi, drain, stop, tmpDir, mediaDir, thumbDir, MAX_BYTES, TYPES };
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

module.exports = { createMediaStore, sniffExt, haveFfmpeg, sha256File, MAX_BYTES, TYPES };
