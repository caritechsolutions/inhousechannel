'use strict';
// Email/password auth with bcrypt hashes and opaque session ids in an HttpOnly cookie.
// Access is by membership: superadmins see every site; everyone else sees the sites they are
// a member of, as `admin` or `editor`.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'ihc_session';
const SESSION_DAYS = 30;
const BCRYPT_ROUNDS = 10;
const ROLE_RANK = { editor: 1, admin: 2 };

function hashPassword(pw) { return bcrypt.hashSync(String(pw), BCRYPT_ROUNDS); }
function verifyPassword(pw, hash) { try { return bcrypt.compareSync(String(pw), String(hash)); } catch { return false; } }

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function normEmail(e) { return String(e || '').trim().toLowerCase(); }

function createUser(db, { email, password, is_superadmin = false }) {
  const em = normEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw badRequest('invalid email');
  if (String(password || '').length < 8) throw badRequest('password must be at least 8 characters');
  const info = db.prepare('INSERT INTO users (email, password_hash, is_superadmin) VALUES (?, ?, ?)').run(em, hashPassword(password), is_superadmin ? 1 : 0);
  return db.prepare('SELECT id, email, is_superadmin, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function createAuth(db) {
  const findUser = db.prepare('SELECT * FROM users WHERE email = ?');
  const insertSession = db.prepare('INSERT INTO sessions (id, user_id, expires_at, ip) VALUES (?, ?, ?, ?)');
  const findSession = db.prepare(`SELECT s.id AS session_id, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
                                  WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  const touchSession = db.prepare("UPDATE sessions SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
  const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
  const purge = db.prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const qMembership = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND site_id = ?');
  const qMemberships = db.prepare('SELECT m.site_id, m.role, s.name, s.slug FROM memberships m JOIN sites s ON s.id = m.site_id WHERE m.user_id = ? ORDER BY s.name');

  // Small brute-force brake: 8 failures per (ip, email) → 60 s lockout.
  const failures = new Map();
  function locked(key) { const f = failures.get(key); return f && f.count >= 8 && Date.now() - f.at < 60000; }
  function fail(key) { const f = failures.get(key) || { count: 0 }; f.count++; f.at = Date.now(); failures.set(key, f); }

  function login({ email, password, ip }) {
    const em = normEmail(email);
    const key = `${ip}|${em}`;
    if (locked(key)) return { error: 'too many attempts, wait a minute', status: 429 };
    const user = findUser.get(em);
    if (!user || !verifyPassword(password, user.password_hash)) { fail(key); return { error: 'invalid email or password', status: 401 }; }
    failures.delete(key);
    const id = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    insertSession.run(id, user.id, expires, ip || null);
    db.prepare("UPDATE users SET last_login = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(user.id);
    if (Math.random() < 0.05) purge.run();
    return { user: publicUser(user), sessionId: id, expires };
  }

  function cookieHeader(sessionId, expires) {
    const maxAge = Math.max(0, Math.floor((new Date(expires).getTime() - Date.now()) / 1000));
    return `${COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }
  const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

  function sessionFromRequest(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (!sid) return null;
    const row = findSession.get(sid);
    if (!row) return null;
    touchSession.run(sid);
    return row;
  }
  function requireAuth(req, res, next) {
    const row = sessionFromRequest(req);
    if (!row) return res.status(401).json({ error: 'not logged in' });
    req.user = publicUser(row);
    req.sessionId = row.session_id;
    next();
  }
  function requireSuperadmin(req, res, next) {
    if (!req.user || !req.user.is_superadmin) return res.status(403).json({ error: 'superadmin only' });
    next();
  }
  // The caller's role on a site ('admin' | 'editor' | null); superadmins are 'admin' everywhere.
  function roleOn(user, siteId) {
    if (!user) return null;
    if (user.is_superadmin) return 'admin';
    const m = qMembership.get(user.id, Number(siteId));
    return m ? m.role : null;
  }
  function siteAccess(req, siteId, minRole = 'editor') {
    const role = roleOn(req.user, siteId);
    return !!role && ROLE_RANK[role] >= ROLE_RANK[minRole];
  }
  function memberships(user) { return user.is_superadmin ? null : qMemberships.all(user.id); }
  function logout(sessionId) { if (sessionId) deleteSession.run(sessionId); }
  function logoutUser(userId) { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); }

  return { login, logout, logoutUser, requireAuth, requireSuperadmin, siteAccess, roleOn, memberships, cookieHeader, clearCookie, sessionFromRequest };
}

function publicUser(u) { return { id: u.id, email: u.email, is_superadmin: !!u.is_superadmin }; }
function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

module.exports = { createAuth, createUser, hashPassword, verifyPassword, parseCookies, normEmail, COOKIE, ROLE_RANK };
