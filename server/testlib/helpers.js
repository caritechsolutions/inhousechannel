'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { buildApp } = require('../src/app');
const { createUser } = require('../src/auth');

function request(base, method, url, { body, raw, cookie, headers = {} } = {}) {
  const u = new URL(base + url);
  const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(raw === undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers,
        ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks), text = buf.toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text, buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Multipart body for one file (+ optional name field).
function multipart(fields, file) {
  const b = `----ihc${Date.now()}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${b}--\r\n`));
  return { raw: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
}

async function startServer(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihc-test-'));
  const logs = [];
  const srv = buildApp({ memory: true, dataDir, log: (m) => logs.push(m), now: opts.now, publicUrl: opts.publicUrl });
  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const call = (method, url, o) => request(base, method, url, o);
  const close = async () => { await srv.media.drain(); await new Promise((r) => srv.server.close(r)); srv.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };

  const root = createUser(srv.db, { email: 'root@example.com', password: 'rootpass1', is_superadmin: true });
  async function login(email = 'root@example.com', password = 'rootpass1') {
    const r = await call('POST', '/api/admin/login', { body: { email, password } });
    return { ...r, cookie: (r.headers['set-cookie'] || [])[0]?.split(';')[0] };
  }
  function addSite(name, slug = name.toLowerCase()) { return srv.db.prepare('INSERT INTO sites (name, slug) VALUES (?, ?)').run(name, slug).lastInsertRowid; }
  function addMember(email, siteId, role = 'editor', password = 'password1') {
    const u = srv.db.prepare('SELECT id FROM users WHERE email = ?').get(email) || createUser(srv.db, { email, password });
    srv.db.prepare('INSERT INTO memberships (user_id, site_id, role) VALUES (?, ?, ?)').run(u.id, siteId, role);
    return u.id;
  }
  return { ...srv, dataDir, base, call, logs, close, login, root, addSite, addMember };
}

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

module.exports = { startServer, request, multipart, PNG };
