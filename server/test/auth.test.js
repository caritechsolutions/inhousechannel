'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../testlib/helpers');

test('login / me / logout', async (t) => {
  const s = await startServer(); t.after(s.close);
  assert.equal((await s.call('GET', '/api/admin/me')).status, 401);
  assert.equal((await s.login('root@example.com', 'wrong')).status, 401);
  const ok = await s.login();
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.is_superadmin, true);
  assert.match(ok.headers['set-cookie'][0], /^ihc_session=.*HttpOnly/);
  const me = await s.call('GET', '/api/admin/me', { cookie: ok.cookie });
  assert.equal(me.json.user.email, 'root@example.com');
  assert.equal((await s.call('POST', '/api/admin/logout', { cookie: ok.cookie })).status, 200);
  assert.equal((await s.call('GET', '/api/admin/me', { cookie: ok.cookie })).status, 401);
});

test('membership scoping: a user of site A cannot see site B', async (t) => {
  const s = await startServer(); t.after(s.close);
  const a = s.addSite('Hotel A', 'a'), b = s.addSite('Hotel B', 'b');
  s.addMember('alice@example.com', a, 'editor');
  const alice = await s.login('alice@example.com', 'password1');
  assert.equal(alice.status, 200);
  const me = await s.call('GET', '/api/admin/me', { cookie: alice.cookie });
  assert.deepEqual(me.json.sites.map((x) => x.id), [a]);
  assert.equal((await s.call('GET', `/api/admin/sites/${a}/players`, { cookie: alice.cookie })).status, 200);
  assert.equal((await s.call('GET', `/api/admin/sites/${b}/players`, { cookie: alice.cookie })).status, 404, 'other sites look nonexistent');
  assert.equal((await s.call('POST', `/api/admin/sites/${b}/players`, { cookie: alice.cookie, body: { name: 'x' } })).status, 404);
  // editors cannot manage members; admins can
  assert.equal((await s.call('GET', `/api/admin/sites/${a}/members`, { cookie: alice.cookie })).status, 403);
  s.addMember('bob@example.com', a, 'admin');
  const bob = await s.login('bob@example.com', 'password1');
  const members = await s.call('GET', `/api/admin/sites/${a}/members`, { cookie: bob.cookie });
  assert.equal(members.status, 200);
  assert.deepEqual(members.json.map((m) => m.email).sort(), ['alice@example.com', 'bob@example.com']);
  // non-superadmins cannot create sites or list users
  assert.equal((await s.call('POST', '/api/admin/sites', { cookie: bob.cookie, body: { name: 'C' } })).status, 403);
  assert.equal((await s.call('GET', '/api/admin/users', { cookie: bob.cookie })).status, 403);
  // superadmin sees both sites and can add alice to B
  const root = await s.login();
  const dash = await s.call('GET', '/api/admin/dashboard', { cookie: root.cookie });
  assert.deepEqual(dash.json.sites.map((x) => x.id), [a, b]);
  const put = await s.call('PUT', `/api/admin/sites/${b}/members`, { cookie: root.cookie, body: { email: 'alice@example.com', role: 'editor' } });
  assert.equal(put.status, 200);
  assert.equal((await s.call('GET', `/api/admin/sites/${b}/players`, { cookie: alice.cookie })).status, 200);
  // dashboard for alice lists only her sites
  const adash = await s.call('GET', '/api/admin/dashboard', { cookie: alice.cookie });
  assert.deepEqual(adash.json.sites.map((x) => x.id).sort(), [a, b]);
});

test('superadmin manages sites and users', async (t) => {
  const s = await startServer(); t.after(s.close);
  const root = await s.login();
  const site = await s.call('POST', '/api/admin/sites', { cookie: root.cookie, body: { name: 'The Nothing Box', timezone: 'America/Barbados' } });
  assert.equal(site.status, 201);
  assert.equal(site.json.slug, 'the-nothing-box');
  assert.equal((await s.call('POST', '/api/admin/sites', { cookie: root.cookie, body: { name: 'The Nothing Box' } })).status, 409);
  const u = await s.call('POST', '/api/admin/users', { cookie: root.cookie, body: { email: 'Carol@Example.com', password: 'carolpass1' } });
  assert.equal(u.status, 201);
  assert.equal(u.json.email, 'carol@example.com');
  assert.equal((await s.call('POST', '/api/admin/users', { cookie: root.cookie, body: { email: 'x@y.z', password: 'short' } })).status, 400);
  const reset = await s.call('PATCH', `/api/admin/users/${u.json.id}`, { cookie: root.cookie, body: { password: 'newpassword1' } });
  assert.equal(reset.status, 200);
  assert.equal((await s.login('carol@example.com', 'carolpass1')).status, 401);
  assert.equal((await s.login('carol@example.com', 'newpassword1')).status, 200);
  assert.equal((await s.call('PATCH', `/api/admin/sites/${site.json.id}`, { cookie: root.cookie, body: { timezone: 'Mars/Olympus' } })).status, 400);
  assert.equal((await s.call('DELETE', `/api/admin/sites/${site.json.id}`, { cookie: root.cookie })).status, 200);
});
